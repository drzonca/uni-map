from models import app, db, Route, Trip, Stop, StopTime, Service
from flask import render_template, jsonify, request
from sqlalchemy import between, select, func

SECONDS_PER_HOUR = 3600

stops_cache = None
geo_by_start = {}


def to_dict_list(data):
    return [e.to_dict() for e in data]


def to_geo_json_feature_collection(features):
    return {
        'type': 'FeatureCollection',
        'features': [f.to_geo_json_dict() for f in features]
    }


@app.route('/')
def show_map():
    return render_template('index.html')


@app.route('/config/')
def config():
    return jsonify(config={
        'mapbox_token': app.config['MAPBOX_ACCESS_TOKEN']
    })


@app.route('/api/routes')
def routes():
    result = Route.query.all()
    if result:
        if request.args.get('asGeoJson'):
            return jsonify(result=to_geo_json_feature_collection(result))
        else:
            return jsonify(result=to_dict_list(result))
    else:
        return jsonify(error="No routes found."), 500


def service_today():
    return select([Service.id]).where(Service.monday)


def first_stop_at_start_time(start_time, end_time):
    return select([StopTime.trip_id]).having(
        between(func.min(StopTime.departure_time), start_time,
                end_time)).group_by(StopTime.trip_id)


@app.route('/api/stops')
def stops():
    global stops_cache
    if not stops_cache:
        result = Stop.query.all()
        if result:
            stops_cache = jsonify(result=to_geo_json_feature_collection(result))
        else:
            return jsonify(result="No stop times found"), 500
    return stops_cache


@app.route('/api/trips/frequency/<int:start_time>')
def trips_at(start_time):
    start_time *= SECONDS_PER_HOUR
    if start_time in geo_by_start:
        return geo_by_start[start_time]
    end_time = start_time + SECONDS_PER_HOUR
    result = Trip.query.filter(
        Trip.id.in_(first_stop_at_start_time(start_time, end_time))).filter(
        Trip.service_id.in_(service_today())).all()
    if result:
        by_route = {}
        for trip in result:
            if not trip.route_id in by_route:
                by_route[trip.route_id] = {}
            by_headsign = by_route[trip.route_id]
            if not trip.headsign in by_headsign:
                by_headsign[trip.headsign] = []
            by_headsign[trip.headsign].append(trip)
        if request.args.get('asGeoJson'):
            collection = {'type': 'FeatureCollection',
                          'features': []}
            for route_id in by_route:
                by_headsign = by_route[route_id]
                for headsign in by_headsign:
                    trips = by_headsign[headsign]
                    trip = trips[0].to_geo_json_dict()
                    trip['properties']['count'] = len(trips)
                    collection['features'].append(trip)
            geo_by_start[start_time] = jsonify(result=collection)
            return geo_by_start[start_time]
        else:
            return jsonify(result=to_dict_list(result))
    else:
        return jsonify(error="No trips found."), 500


@app.route('/api/trips/')
def trips():
    result = Trip.query.all()
    if result:
        return jsonify(result=to_dict_list(result))
    else:
        return jsonify(error="No trips found."), 500


if __name__ == '__main__':
    app.run()
