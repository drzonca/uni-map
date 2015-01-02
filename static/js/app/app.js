require(['jquery', 'mapbox', 'domReady!'], function ($) {

    var map;

    var defaultColor = '#82BEE8';
    var baseOffsetPx = 2;

    var totalWeightByPoint;

    var agencyOffset;
    var lastAgencyOffset;
    var agencyOffsetMemo;
    var features;
    var lines;
    var opts;
    var properties;

    var init = function () {
        totalWeightByPoint = {};
        agencyOffset = 0;
        lines = [];
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
     * Applies a given offset to a given point
     *
     * @returns {*}     the point, with offset applied
     */
    var applyOffset = function (point, myOffset, ref1, ref2) {
        if (properties['rtype'] == 1) {
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
        var ref1, ref2;
        if (points[i + 1]) {
            ref1 = point, ref2 = points[i + 1];
        } else {
            ref1 = points[i - 1], ref2 = point;
        }
        var myOffset = (agencyOffset >= 0) ? getOffset() : -getOffset();
        var corrected = applyOffset(point, agencyOffset, ref1, ref2);
        var weightAtPoint = overlapsExisting(point);
        if (weightAtPoint) {
            var totalOffset = myOffset >= 0 ? myOffset + pxToCoord(weightAtPoint) : myOffset - pxToCoord(weightAtPoint);
            corrected = applyOffset(corrected, totalOffset, ref1, ref2);
            totalWeightByPoint[hash(point)] += opts.weight;
        } else {
            totalWeightByPoint[hash(point)] = opts.weight;
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
        agencyOffset = getAgencyOffset(properties['agency_id']);

        if (feature['coordinates'] && feature['coordinates'][0]) {
            try {
                opts = {
                    opacity: 1,
                    weight: 2
                };
                if ($.trim(properties['color'])) {
                    opts.color = '#' + properties['color'];
                }
                /* Override color and weight for different types of routes */
                if (properties['rtype'] == 0) {
                    /* Light rail lines */
                    opts.weight = 4;
                } else if (properties['rtype'] == 1) {
                    /* Metro lines */
                    opts.weight = 6;
                } else if (properties['long_name'].match(/limited/i)) {
                    opts.weight = 4;
                    opts.color = opts.color || 'green';
                } else if (properties['long_name'].match(/express/i)) {
                    opts.color = opts.color || 'red';
                    opts.weight = 1;
                } else if (properties['long_name'].match(/owl/i)) {
                    opts.color = opts.color || 'blue';
                    opts.weight = 1;
                }
                opts.color = opts.color || defaultColor;
                opts.weight *= featureWeightCorrection();
                var latLongs = feature['coordinates'][0].map(function (longLat) {
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

    var renderFeatures = function () {
        for (var i in features) {
            var feature = features[i];
            var polyline = featureToPolyline(feature);
            if (polyline) {
                polyline.addTo(map);
                lines.push(polyline);
            }
        }
    }

    init();


    $.ajax("/config/").done(function (data) {

        L.mapbox.accessToken = data.config.mapbox_token;
        map = L.mapbox.map('map', data.config.mapbox_map);

        map.on('zoomstart', function () {
            lines.forEach(function (line) {
                map.removeLayer(line);
            });
        });

        map.on('viewreset', function () {
            console.log(map.getZoom());
            renderFeatures();
        });

    }).then(function () {
        $.ajax("/api/routes?asGeoJson=true").done(function (data) {
            init();
            features = data.result['features'].sort(function (a, b) {
                var propA = a['properties'], propB = b['properties'];
                if (propA['short_name'] < propB['short_name']) {
                    return -1
                } else if (propA['short_name'] > propB['short_name']) {
                    return 1;
                } else {
                    return propA['long_name'] < propB['long_name'] ? -1 : 1;
                }
            });
            renderFeatures();
        });
    })
});