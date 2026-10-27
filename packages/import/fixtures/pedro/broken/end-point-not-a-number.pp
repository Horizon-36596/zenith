{
  "startPoint": {
    "x": 58.75,
    "y": 7.75,
    "headingDeg": 90,
    "locked": false
  },
  "lines": [
    {
      "id": "a1b2c3",
      "kind": "atomic",
      "name": "To Score",
      "color": "#ffc516",
      "locked": false,
      "endPoint": {
        "x": 58.75,
        "y": 34.75
      },
      "controlPoints": [],
      "heading": {
        "type": "tangential",
        "reverse": false
      },
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "id": "d4e5f6",
      "kind": "atomic",
      "name": "Garden Approach",
      "color": "#4ade80",
      "locked": false,
      "endPoint": {
        "x": "9.75",
        "y": 26.75
      },
      "controlPoints": [
        {
          "x": 30.75,
          "y": 40.75
        }
      ],
      "heading": {
        "type": "linear",
        "startDeg": 90,
        "endDeg": -90
      },
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "id": "g7h8i9",
      "kind": "atomic",
      "name": "Garden Pickup",
      "color": "#60a5fa",
      "locked": false,
      "endPoint": {
        "x": 12.75,
        "y": 12.75
      },
      "controlPoints": [],
      "heading": {
        "type": "constant",
        "degrees": -90
      },
      "waitBeforeMs": 0,
      "waitAfterMs": 250,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "id": "j1k2l3",
      "kind": "atomic",
      "name": "Back To Score",
      "color": "#f472b6",
      "locked": false,
      "endPoint": {
        "x": 58.75,
        "y": 34.75
      },
      "controlPoints": [
        {
          "x": 20.75,
          "y": 20.75
        },
        {
          "x": 46.75,
          "y": 40.75
        }
      ],
      "heading": {
        "type": "tangential",
        "reverse": true
      },
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "id": "m4n5o6",
      "kind": "atomic",
      "name": "Park",
      "color": "#a78bfa",
      "locked": false,
      "endPoint": {
        "x": 30.75,
        "y": 34.75
      },
      "controlPoints": [],
      "heading": {
        "type": "constant",
        "degrees": 180
      },
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    }
  ],
  "shapes": [
    {
      "id": "triangle-1",
      "name": "Red Goal",
      "vertices": [
        {
          "x": 141.5,
          "y": 70
        },
        {
          "x": 141.5,
          "y": 141.5
        },
        {
          "x": 118.3,
          "y": 141.5
        },
        {
          "x": 135.5,
          "y": 118
        },
        {
          "x": 136.3,
          "y": 70.2
        }
      ],
      "color": "#dc2626",
      "fillColor": "#ff6b6b"
    }
  ],
  "sequence": [
    {
      "kind": "path",
      "lineId": "a1b2c3"
    },
    {
      "kind": "wait",
      "id": "w1",
      "name": "Score preload",
      "durationMs": 1500
    },
    {
      "kind": "path",
      "lineId": "d4e5f6"
    },
    {
      "kind": "path",
      "lineId": "g7h8i9"
    },
    {
      "kind": "wait",
      "id": "w2",
      "name": "Intake settle",
      "durationMs": 800
    },
    {
      "kind": "path",
      "lineId": "j1k2l3"
    },
    {
      "kind": "wait",
      "id": "w3",
      "name": "Score cycle",
      "durationMs": 1500
    },
    {
      "kind": "path",
      "lineId": "m4n5o6"
    }
  ],
  "settings": {
    "xVelocity": 75,
    "yVelocity": 65,
    "aVelocity": 3.141592653589793,
    "kFriction": 0.1,
    "rWidth": 18,
    "rHeight": 18,
    "safetyMargin": 1,
    "maxVelocity": 40,
    "maxAcceleration": 30,
    "maxDeceleration": 30,
    "fieldMap": "biobuzz.webp",
    "robotImage": "/robot.png",
    "showGhostPaths": false,
    "showOnionLayers": false,
    "onionLayerSpacing": 3,
    "onionColor": "#dc2626",
    "onionNextPointOnly": false,
    "showHeadingArrow": false,
    "showCurrentTValue": false,
    "leftPanelWidth": 370,
    "rightPanelWidth": 620,
    "headingArrowLength": 50,
    "headingArrowColor": "#ffffff",
    "headingArrowThickness": 2,
    "pathOpacity": 1,
    "leftPanelMinWidth": 0,
    "rightPanelMinWidth": 0,
    "penToolMaxPaths": 8,
    "curveThroughMaxPoints": 4,
    "experimentalFeatures": {
      "optimize": false,
      "curveThrough": false
    }
  },
  "version": "1.5.0",
  "timestamp": "2026-09-27T15:04:05.000Z"
}
