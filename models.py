__author__ = 'dean'

import json
from flask import Flask
from flask.ext.sqlalchemy import SQLAlchemy
from geoalchemy2 import Geometry, functions as geofunc

app = Flask(__name__, instance_relative_config=True)
app.debug = True
app.config.from_pyfile('config.py')

db = SQLAlchemy(app)


class Service(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    monday = db.Column(db.Boolean)
    tuesday = db.Column(db.Boolean)
    wednesday = db.Column(db.Boolean)
    thursday = db.Column(db.Boolean)
    friday = db.Column(db.Boolean)
    saturday = db.Column(db.Boolean)
    sunday = db.Column(db.Boolean)

    def __init__(self, id, monday, tuesday, wednesday, thursday, friday, saturday, sunday):
        self.id = id
        self.monday = monday
        self.tuesday = tuesday
        self.wednesday = wednesday
        self.thursday = thursday
        self.friday = friday
        self.saturday = saturday
        self.sunday = sunday

    def __repr__(self):
        return '<Service %d%d%d%d%d%d%d>' % (
            self.monday, self.tuesday, self.wednesday, self.thursday, self.friday, self.saturday, self.sunday)


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


class Stop(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String)
    point = db.Column(Geometry('POINT'))

    def __init__(self, id, name, point):
        self.id = id
        self.name = name
        self.point = point

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name
        }

    def to_geo_json_dict(self):
        feature = json.loads(db.session.scalar(geofunc.ST_AsGeoJSON(self.point)))
        feature['properties'] = self.to_dict()
        return feature


class StopTime(db.Model):
    __tablename__ = 'stop_time'
    id = db.Column(db.Integer, primary_key=True)
    trip_id = db.Column(db.Integer, db.ForeignKey('trip.id'))
    trip = db.relationship('Trip', backref='stop_times')
    stop_id = db.Column(db.Integer, db.ForeignKey('stop.id'))
    stop = db.relationship('Stop', backref='stop_times')
    arrival_time = db.Column(db.Integer)
    departure_time = db.Column(db.Integer)
    stop_sequence = db.Column(db.Integer)

    def __init__(self, id, trip_id, stop_id, arrival_time, departure_time, stop_sequence):
        self.id = id
        self.trip_id = trip_id
        self.stop_id = stop_id
        self.arrival_time = arrival_time
        self.departure_time = departure_time
        self.stop_sequence = stop_sequence

    def to_dict(self):
        return {
            'id': self.id,
            'trip_id': self.trip_id,
            'stop_id': self.stop_id,
            'arrival_time': self.arrival_time,
            'departure_time': self.departure_time,
            'stop_sequence': self.stop_sequence,
        }


class Trip(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    route_id = db.Column(db.Integer, db.ForeignKey('route.id'))
    route = db.relationship('Route')
    service_id = db.Column(db.Integer, db.ForeignKey('service.id'))
    headsign = db.Column(db.String(256))
    geometry = db.Column(Geometry('LINE'))

    def __init__(self, id, route_id, service_id, headsign, geometry):
        self.id = id
        self.route_id = route_id
        self.service_id = service_id
        self.headsign = headsign
        self.geometry = geometry

    def __repr__(self):
        return '<Trip %r>' % self.headsign

    def to_dict(self):
        return {
            'id': self.id,
            'route_id': self.route_id,
            'service_id': self.service_id,
            'headsign': self.headsign,
            'route': self.route.to_dict(),
            'stop_ids': [st.stop_id for st in self.stop_times]
        }

    def to_geo_json_dict(self):
        feature = json.loads(db.session.scalar(geofunc.ST_AsGeoJSON(self.geometry)))
        feature['properties'] = self.to_dict()
        return feature