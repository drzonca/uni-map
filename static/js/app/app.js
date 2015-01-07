require(['jquery', 'mapbox', 'domReady!'], function ($) {

    var map;

    var defaultColor = '#82BEE8';
    var baseOffsetPx = 2;

    var totalWeightByPoint;
    var routeOffsetByPoint;

    var agencyOffset;
    var lastAgencyOffset;
    var agencyOffsetMemo;
    var tripFeatures;
    var stopFeatures;
    var lines;
    var points;
    var opts;
    var properties;
    var routeIdsByStop;
    var routesById;

    var init = function () {
        totalWeightByPoint = {};
        routeOffsetByPoint = {};
        routeIdsByStop = {};
        routesById = {};
        agencyOffset = 0;
        lines = [];
        points = [];
        agencyOffsetMemo = {};
        lastAgencyOffset = undefined;
    };

    var pxToCoord = function (px) {
        var latLngBounds = map.getBounds();
        var width = latLngBounds.getEast() - latLngBounds.getWest();
        var widthPx = map.getSize().x;
        var coordPerPx = width / widthPx;
        return px * coordPerPx;
    };

    /**
     * Make features smaller when zoomed out to reduce
     * crowding.
     *
     * Fudge factor based on trial and error.
     */
    var featureWeightCorrection = function () {
        var mapZoom = map.getZoom();
        switch (mapZoom) {
            case 19:
                return 1;
                break;
            case 18:
                return 1;
                break;
            case 17:
                return .9;
                break;
            case 16:
                return .8;
                break;
            case 15:
                return .7;
                break;
            case 14:
                return .4;
                break;
            case 13:
                return .3;
                break;
            case 12:
                return .2;
                break;
            default:
                return .1;
        }
    };

    var getOffset = function () {
        return featureWeightCorrection() * pxToCoord(baseOffsetPx);
    };

    /**
     * Computes an offset to apply to all routes
     * for a given agency.
     *
     * Each time a new agency is encountered, increase
     * the magnitude of the offset, and reverse the direction.
     *
     * This is useful in cases where lines from different agencies
     * follow the same street, but their lines are defined by slightly
     * different points. For example, Muni lines on Market Street
     * will spread out to the north, and BART lines will spread out to
     * the south (depending of course on which agency is encountered first).
     */
    var getAgencyOffset = function (agencyId) {
        if (agencyId in agencyOffsetMemo) {
            return agencyOffsetMemo[agencyId];
        } else {
            var generated = 0;
            if (typeof lastAgencyOffset != 'undefined') {
                var sign = lastAgencyOffset >= 0 ? -1 : 1;
                generated = Math.abs(lastAgencyOffset + (sign * 6 * getOffset())) * sign;
            }
            lastAgencyOffset = generated;
            agencyOffsetMemo[agencyId] = generated;
            return generated;
        }
    };

    /**
     * Computes a hash for a given coordinate.
     *
     * Allows for quick checks against existing points
     */
    var hash = function (point) {
        return Math.abs(point[0] + (2 * point[1]));
    };

    /**
     * Applies a given offset to a given point.
     *
     * For metro lines only, attempt to offset perpendicular
     * to the direction of the already existing line. Since bus lines
     * often have irregular shapes, this method won't work reliably.
     *
     * @returns {*}     the point, with offset applied
     */
    var applyOffset = function (point, myOffset, ref1, ref2) {
        /* Sort the points, since lines may alternate directions */
        var diff = (ref2[1] - ref1[1]) - (ref2[0] + ref1[0]);
        if (diff > 0) {
            var tmp = ref2;
            ref2 = ref1;
            ref1 = tmp;
        }
        if (properties['route']['rtype'] == 1) {
            /* Space perpendicular for metro lines */
            var delta = [
                ref2[0] - ref1[0],
                ref2[1] - ref1[1]
            ];
            /* Find the distance between the reference points (a^2 + b^2 = c^2) */
            var deltaMag = Math.sqrt(Math.pow(delta[0], 2) + Math.pow(delta[1], 2));
            var offsetMag = Math.sqrt(2 * Math.pow(myOffset, 2));
            var proportion = [delta[0] / deltaMag, delta[1] / deltaMag];
            return [
                point[0] + (offsetMag * proportion[1]),
                point[1] - (offsetMag * proportion[0])
            ];
        } else {
            return [
                point[0] - myOffset,
                point[1] + myOffset
            ];
        }
    };

    /**
     * Determines whether a point overlaps another point
     * @param point
     * @returns     a truthy value if another point was already placed
     *              at the same location
     */
    var overlapsExisting = function (point) {
        return totalWeightByPoint[hash(point)];
    };

    /**
     * Offsets points in a line that overlap with
     * points in other lines that have already been placed.
     *
     * If a point overlaps an existing point, and either the point
     * before it or after it also overlaps an existing point,
     * offset the current point.
     *
     * @param point     the point to offset
     * @param i         the index of the point in its line
     * @param points    the line containing the point
     * @returns         the point with the offset applied
     */
    var offsetOverlap = function (point, i, points) {
        var routeId = properties['route']['id'];
        var key = hash(point);
        var ref1, ref2;
        if (points[i + 1]) {
            ref1 = point;
            ref2 = points[i + 1];
        } else {
            ref1 = points[i - 1];
            ref2 = point;
        }
        var myOffset = (agencyOffset >= 0) ? getOffset() : -getOffset();
        var corrected = applyOffset(point, agencyOffset, ref1, ref2);
        if (!routeOffsetByPoint[key]) {
            routeOffsetByPoint[key] = {};
        }
        if (routeOffsetByPoint[key][routeId]) {
            corrected = applyOffset(corrected, routeOffsetByPoint[key][routeId]);
        } else if (properties['route']['rtype'] == 1) {
            var weightAtPoint = overlapsExisting(point);
            if (weightAtPoint) {
                var totalOffset = myOffset >= 0 ? myOffset + pxToCoord(weightAtPoint) : myOffset - pxToCoord(weightAtPoint);
                routeOffsetByPoint[key][routeId] = totalOffset;
                corrected = applyOffset(corrected, totalOffset, ref1, ref2);
                totalWeightByPoint[key] += opts.weight;
            } else {
                routeOffsetByPoint[key][routeId] = 0;
                totalWeightByPoint[key] = opts.weight;
            }
        }
        return corrected;
    };

    /**
     * Converts a GeoJSON feature into a Leaflet Polyline
     * @param feature
     * @returns {*}     a Leaflet Polyline appropriately colored and offset,
     *                  ready to place on the map
     */
    var featureToPolyline = function (feature) {
        properties = feature['properties'];
        var route = properties['route'];
        agencyOffset = getAgencyOffset(route['agency_id']);

        if (feature['coordinates'] && feature['coordinates'][0]) {
            try {
                opts = {
                    opacity: .67,
                    weight: properties['count']
                };
                if ($.trim(route['color'])) {
                    opts.color = '#' + route['color'];
                }
                /* Override color and weight for different types of routes */
                if (route['long_name'].match(/limited/i)) {
                    opts.color = opts.color || 'green';
                } else if (route['long_name'].match(/express/i)) {
                    opts.color = opts.color || 'red';
                } else if (route['long_name'].match(/owl/i)) {
                    opts.color = opts.color || 'blue';
                }
                opts.color = opts.color || defaultColor;
                opts.weight *= featureWeightCorrection();
                var latLongs = feature['coordinates'].map(function (longLat) {
                    /*
                     * The server data has [long, lat], but we need [lat, long]
                     * Copy the array first so we don't reverse the original.
                     * */
                    return longLat.slice(0).reverse();
                }).map(offsetOverlap);
                return L.polyline(latLongs, opts);
            } catch (e) {
                console.log(e);
            }
        }
    };

    var featureToPoint = function (feature) {
        properties = feature['properties'];
        var label = "";
        var stopId = properties['id'];
        var routeCount = 0;
        var className = 'stop-icon';
        if (map.getZoom() < 15) {
            className += ' small';
        }
        if (routeIdsByStop[stopId]) {
            if (map.getZoom() >= 15) {
                for (var routeId in routeIdsByStop[stopId]) {
                    var shortName = routesById[routeId]['short_name'];
                    label += $.trim(shortName) + " ";
                    routeCount++;
                }
            }
            return L.marker([feature['coordinates'][1], feature['coordinates'][0]], {
                icon: L.divIcon(
                    {
                        // Specify a class name we can refer to in CSS.
                        className: className,
                        // Define what HTML goes in each marker.
                        html: '<span title="' + properties['name'] + '">' + $.trim(label) + '</span>',
                        // Set a markers width and height.
                        iconSize: ['auto', 16]
                    }
                )
            });
        }
    };

    var saveMapPosition = function () {
        if (typeof localStorage !== 'undefined') {
            localStorage['mapZoom'] = map.getZoom();
            localStorage['mapCenter'] = JSON.stringify(map.getCenter());
        }
    };

    var restoreMapPosition = function () {
        try {
            if (typeof localStorage !== 'undefined') {
                if (localStorage['mapZoom']) {
                    map.setZoom(localStorage['mapZoom']);
                }
                if (localStorage['mapCenter']) {
                    map.panTo(JSON.parse(localStorage['mapCenter']));
                }
            }
        } catch (e) {
            console.log("Couldn't restore map position: " + e);
        }
    };

    var renderFeatures = function () {
        for (var i in tripFeatures) {
            var feature = tripFeatures[i];
            var routeId = feature['properties']['route_id'];
            var stops = feature['properties']['stop_ids'];
            routesById[routeId] = feature['properties']['route'];
            for (var i in stops) {
                var stop = stops[i];
                if (!routeIdsByStop[stop]) {
                    routeIdsByStop[stop] = {};
                }
                routeIdsByStop[stop][routeId] = true;
            }
            var polyline = featureToPolyline(feature);
            if (polyline) {
                polyline.addTo(map);
                lines.push(polyline);
            }
        }
        if (map.getZoom() > 12) {
            for (var i in stopFeatures) {
                var feature = stopFeatures[i];
                var marker = featureToPoint(feature);
                if (marker) {
                    marker.addTo(map);
                    points.push(marker);
                }
            }
        }
    };

    init();


    $.ajax("/config/").done(function (data) {

        L.mapbox.accessToken = data.config.mapbox_token;
        map = L.mapbox.map('map', data.config.mapbox_map);

        map.on('zoomstart', function () {
            lines.forEach(function (line) {
                map.removeLayer(line);
            });
            points.forEach(function (point) {
                map.removeLayer(point);
            });
        });

        map.on('moveend', function () {
            saveMapPosition();
        });

        map.on('viewreset', function () {
            console.log(map.getZoom());
            saveMapPosition();
            init();
            renderFeatures();
        });

        restoreMapPosition();

    }).then(function () {
        $.ajax("/api/stops").done(function (data) {
            stopFeatures = data.result['features'];

        }).then(function () {
            $.ajax("/api/trips/frequency/14?asGeoJson=true").done(function (data) {
                init();
                tripFeatures = data.result['features'].sort(function (a, b) {
                    var propA = a['properties'], propB = b['properties'];
                    var routeA = propA['route'], routeB = propB['route'];
                    if (routeA['short_name'] < routeB['short_name']) {
                        return -1
                    } else if (routeA['short_name'] > routeB['short_name']) {
                        return 1;
                    } else {
                        return routeA['long_name'] < routeB['long_name'] ? -1 : 1;
                    }
                });
                renderFeatures();
            });
        });
    });
})
;
