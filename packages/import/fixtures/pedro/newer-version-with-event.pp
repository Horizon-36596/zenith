{
  "startPoint": {
    "x": 58.75,
    "y": 7.75,
    "headingDeg": 90
  },
  "lines": [
    {
      "id": "p1",
      "kind": "atomic",
      "name": "Drive Out",
      "color": "#ffc516",
      "endPoint": {
        "x": 58.75,
        "y": 34.75
      },
      "controlPoints": [],
      "heading": {
        "type": "constant",
        "degrees": 90
      },
      "speedFraction": 0.6
    },
    {
      "id": "p2",
      "kind": "atomic",
      "name": "Park",
      "color": "#a78bfa",
      "endPoint": {
        "x": 30.75,
        "y": 34.75
      },
      "controlPoints": [],
      "heading": {
        "type": "tangential",
        "reverse": false
      }
    }
  ],
  "shapes": [],
  "sequence": [
    {
      "kind": "path",
      "lineId": "p1"
    },
    {
      "kind": "event",
      "id": "e1",
      "name": "Intake on"
    },
    {
      "kind": "path",
      "lineId": "p2"
    }
  ],
  "markers": [
    {
      "t": 0.5,
      "name": "Intake on"
    }
  ],
  "version": "1.7.0",
  "timestamp": "2026-12-01T09:00:00.000Z"
}
