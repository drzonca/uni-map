from models import app, Route
from flask import Flask, render_template, jsonify, request


def to_dict_list(data):
    return [e.to_dict() for e in data]


def to_geo_json_feature_collection(features):
    return {
        'type': 'FeatureCollection',
        'features': [f.to_geo_json_dict() for f in features]
    }


@app.route('/')
def show_map():
    return render_template('app.html')


@app.route('/config/')
def config():
    return jsonify(config={
        'mapbox_token': app.config['MAPBOX_ACCESS_TOKEN'],
        'mapbox_map': app.config['MAPBOX_MAP']
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


if __name__ == '__main__':
    app.run()
