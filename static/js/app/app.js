var useMapbox = false; // TODO: control this somehow

var uniMapApp = angular.module('uniMapApp', ['LocalStorageModule', 'leaflet-directive']);

uniMapApp.config(function (localStorageServiceProvider) {
    localStorageServiceProvider
        .setPrefix('uni-map');
});

uniMapApp.factory('StopService', ['$http', '$q', function ($http, $q) {
    return {
        get: function () {
            var deferred = $q.defer();
            $http({
                cache: true,
                url: '/api/stops',
                method: 'GET'
            }).success(function (data) {
                deferred.resolve(data.result.features);
            }).error(function (msg) {
                deferred.reject(msg);
            });
            return deferred.promise;
        }
    };
}]);

uniMapApp.factory('TripService', ['$http', '$q', function ($http, $q) {
    return {
        get: function (hour) {
            var deferred = $q.defer();
            $http({
                cache: true,
                url: '/api/trips/frequency/' + hour + '?asGeoJson=true',
                method: 'GET'
            }).success(function (data) {
                deferred.resolve(data.result['features'].sort(function (a, b) {
                    var propA = a['properties'], propB = b['properties'];
                    var routeA = propA['route'], routeB = propB['route'];
                    if (routeA['short_name'] < routeB['short_name']) {
                        return -1
                    } else if (routeA['short_name'] > routeB['short_name']) {
                        return 1;
                    } else {
                        return routeA['long_name'] < routeB['long_name'] ? -1 : 1;
                    }
                }));
            }).error(function (msg) {
                deferred.reject(msg);
            });
            return deferred.promise;
        }
    };
}]);

uniMapApp.controller('MapController', [
    '$scope',
    '$q',
    '$log',
    '$timeout',
    'leafletData',
    'localStorageService',
    'StopService',
    'TripService', function ($scope, $q, $log, $timeout, leafletData, localStorageService, StopService, TripService) {

        $scope.paths = [];
        $scope.markers = [];

        // Configure the tile source
        var tilesDict = {
            mapQuest: {
                url: 'http://otile1.mqcdn.com/tiles/1.0.0/map/{z}/{x}/{y}.png',
                minZoom: 10,
                maxZoom: 18
            }
        };
        $scope.tiles = tilesDict.mapQuest;
        // Use fancy mapbox tiles if you want
        if (useMapbox) {
            $.ajax('/config').done(function (data) {
                tilesDict.mapbox = {
                    url: 'https://{s}.tiles.mapbox.com/v4/mapbox.streets/{z}/{x}/{y}' + (L.Browser.retina ? '@2x' : '') + '.png?access_token=' + data.config.mapbox_token,
                    minZoom: 10,
                    maxZoom: 18,
                    detectRetina: true,
                    attribution: '<a href="http://www.mapbox.com/about/maps/" target="_blank">Terms &amp; Feedback</a>'
                }
                $scope.tiles = tilesDict.mapbox;
            });
        }

        // Restore existing map center, or set to a sensible default
        if (localStorageService.get('mapCenter')) {
            $scope.center = localStorageService.get('mapCenter');
        } else {
            $scope.center = {
                "lat": 37.77071473849609,
                "lng": -122.44022369384766,
                "zoom": 12
            };
        }

        $scope.$on('leafletDirectiveMap.viewreset', function () {
            $log.info("Redrawing features");
            init();
            $timeout(renderFeatures, 0);
        });

        $scope.$on('leafletDirectiveMap.zoomstart', function () {
            $scope.paths.forEach(function (path) {
                map.removeLayer(path);
            });
        });

        // Listen for events that change the map center
        angular.forEach(['leafletDirectiveMap.viewreset', 'leafletDirectiveMap.moveend'], function (eventId) {
            $scope.$on(eventId, function () {
                $log.info("Center changed");
                localStorageService.set('mapCenter', $scope.center);
            });
        });

        $q.all([
            leafletData.getMap(),
            StopService.get(),
            TripService.get(15)]).then(
            function (results) {
                map = results[0];
                $scope.stops = results[1];
                $scope.trips = results[2];

                init();
                renderFeatures();
            });


        /* begin spaghetti code */
        var map;
        var defaultColor = '#333333';
        var baseOffsetPx = 2;

        var totalWeightByPoint;
        var routeOffsetByPoint;

        var agencyOffset;
        var lastAgencyOffset;
        var agencyOffsetMemo;
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
            $scope.paths = [];
            $scope.markers = [];
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
            var mapZoom = $scope.center.zoom;
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
            return String(point[0]) + String(point[1]);
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
            if (properties['route']['rtype'] == 1) {
                /* Space perpendicular for metro lines */
                var delta = [
                    ref2[0] - ref1[0],
                    ref2[1] - ref1[1]
                ];
                /* Find the distance between the reference points (a^2 + b^2 = c^2) */
                var direction = myOffset >= 0 ? 1 : -1;
                var deltaMag = Math.sqrt(Math.pow(delta[0], 2) + Math.pow(delta[1], 2));
                var offsetMag = Math.sqrt(2 * Math.pow(myOffset, 2));
                var proportion = [Math.abs(delta[0] / deltaMag) * direction, Math.abs(delta[1] / deltaMag) * direction];
                return [
                    point[0] - (offsetMag * proportion[1]),
                    point[1] + (offsetMag * proportion[0])
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
            if (typeof(routeOffsetByPoint[key][routeId]) != 'undefined') {
                corrected = applyOffset(corrected, routeOffsetByPoint[key][routeId], ref1, ref2);
            } else if (properties['route']['rtype'] in [1, 3]) {
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
         * Converts a GeoJSON feature into a Leaflet path
         * @param feature
         * @returns {*}     a Leaflet Polyline appropriately colored and offset,
         *                  ready to place on the map
         */
        var featureToPath = function (feature) {
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
                    var latLngs = feature['coordinates'].map(function (longLat) {
                        /*
                         * The server data has [long, lat], but we need [lat, long]
                         * Copy the array first so we don't reverse the original.
                         * */
                        return [
                            longLat[1],
                            longLat[0]
                        ];
                    }).map(offsetOverlap);
                    return L.polyline(latLngs, opts);
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
            if ($scope.center.zoom < 15) {
                className += ' small';
            }
            if (routeIdsByStop[stopId]) {
                if ($scope.center.zoom >= 15) {
                    for (var routeId in routeIdsByStop[stopId]) {
                        var shortName = routesById[routeId]['short_name'];
                        label += $.trim(shortName) + " ";
                        routeCount++;
                    }
                }
                return {
                    lat: feature['coordinates'][1],
                    lng: feature['coordinates'][0],
                    icon: {
                        type: 'div',
                        html: '<span title="' + properties['name'] + '">' + $.trim(label) + '</span>',
                        className: className,
                        iconSize: ['auto', 16]
                    }
                };
            }
        };

        var renderFeatures = function () {
            for (var i in $scope.trips) {
                var feature = $scope.trips[i];
                var routeId = feature['properties']['route_id'];
                var stops = feature['properties']['stop_ids'];
                routesById[routeId] = feature['properties']['route'];
                for (var j in stops) {
                    var stop = stops[j];
                    if (!routeIdsByStop[stop]) {
                        routeIdsByStop[stop] = {};
                    }
                    routeIdsByStop[stop][routeId] = true;
                }
                var path = featureToPath(feature);
                if (path) {
                    path.addTo(map);
                    $scope.paths.push(path);
                }
            }

            $log.info("Rendered " + i + " paths");

            if ($scope.center.zoom > 12) {
                for (var i in $scope.stops) {
                    var feature = $scope.stops[i];
                    var marker = featureToPoint(feature);
                    if (marker) {
                        $scope.markers.push(marker);
                    }
                }
            }
        };
    }])
;