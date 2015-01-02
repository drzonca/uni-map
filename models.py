__author__ = 'dean'

import json
from flask import Flask
from flask.ext.sqlalchemy import SQLAlchemy
from geoalchemy2 import Geometry, functions as geofunc

app = Flask(__name__, instance_relative_config=True)
app.debug = True
app.config.from_pyfile('config.py')

db = SQLAlchemy(app)


class Route(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    agency_id = db.Column(db.Integer)
    short_name = db.Column(db.String(256))
    long_name = db.Column(db.String(256))
    color = db.Column(db.String(6))
    rtype = db.Column(db.Integer)
    geometry = db.Column(Geometry('MULTILINE'))

    def __init__(self, id, agency_id, short_name, long_name, color, rtype, geometry):
        self.id = id
        self.agency_id = agency_id
        self.short_name = short_name
        self.long_name = long_name
        self.color = color
        self.rtype = rtype
        self.geometry = geometry

    def __repr__(self):
        return '<Route %r>' % self.short_name

    def to_dict(self):
        return {
            'id': self.id,
            'agency_id': self.agency_id,
            'short_name': self.short_name,
            'long_name': self.long_name,
            'rtype': self.rtype,
            'color': self.color
        }

    def to_geo_json_dict(self):
        feature = json.loads(db.session.scalar(geofunc.ST_AsGeoJSON(self.geometry)))
        coordinates = feature['coordinates']
        if len(coordinates) > 1:
            feature['coordinates'] = [coordinates[0]]
        feature['properties'] = self.to_dict()
        return feature