{
  "startPoint": {
    "x": 30.75,
    "y": 7.75,
    "headingDeg": 90,
    "locked": false,
    "name": "start"
  },
  "lines": [
    {
      "id": "grp-out",
      "kind": "compound",
      "name": "Out And Across",
      "color": "#ffc516",
      "locked": false,
      "heading": {
        "type": "linear",
        "startDeg": 90,
        "endDeg": 0
      },
      "segments": [
        {
          "id": "out-1",
          "kind": "atomic",
          "name": "",
          "color": "#ffc516",
          "endPoint": {
            "x": 30.75,
            "y": 25.75
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
          "id": "out-2",
          "kind": "atomic",
          "name": "",
          "color": "#ffc516",
          "endPoint": {
            "x": 44.75,
            "y": 38.75
          },
          "controlPoints": [
            {
              "x": 30.75,
              "y": 38.75
            }
          ],
          "heading": {
            "type": "tangential",
            "reverse": false
          },
          "waitBeforeMs": 0,
          "waitAfterMs": 0,
          "waitBeforeName": "",
          "waitAfterName": ""
        }
      ],
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "id": "hook",
      "kind": "atomic",
      "name": "Hook Around",
      "color": "#4ade80",
      "locked": false,
      "endPoint": {
        "x": 34.75,
        "y": 20.75
      },
      "controlPoints": [
        {
          "x": 60.75,
          "y": 38.75
        },
        {
          "x": 66.75,
          "y": 26.75
        },
        {
          "x": 58.75,
          "y": 14.75
        },
        {
          "x": 46.75,
          "y": 14.75
        }
      ],
      "heading": {
        "type": "piecewise",
        "piecewiseHeading": {
          "segments": [
            {
              "startProgress": 0,
              "endProgress": 0.4,
              "interpolationType": "tangential",
              "reversed": false
            },
            {
              "startProgress": 0.4,
              "endProgress": 0.7,
              "interpolationType": "constant",
              "continueFromPrevious": true,
              "parameters": {
                "degrees": 0
              }
            },
            {
              "startProgress": 0.7,
              "endProgress": 1,
              "interpolationType": "facing-point",
              "reversed": false,
              "parameters": {
                "point": {
                  "x": 9.75,
                  "y": 8.75
                }
              }
            }
          ]
        }
      },
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "id": "grp-garden",
      "kind": "compound",
      "name": "Garden Run",
      "color": "#60a5fa",
      "locked": false,
      "segments": [
        {
          "id": "garden-1",
          "kind": "atomic",
          "name": "",
          "color": "#60a5fa",
          "endPoint": {
            "x": 12.75,
            "y": 20.75
          },
          "controlPoints": [],
          "heading": {
            "type": "linear",
            "startDeg": 0,
            "endDeg": -90
          },
          "waitBeforeMs": 0,
          "waitAfterMs": 0,
          "waitBeforeName": "",
          "waitAfterName": ""
        },
        {
          "id": "garden-2",
          "kind": "atomic",
          "name": "",
          "color": "#60a5fa",
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
          "waitAfterMs": 0,
          "waitBeforeName": "",
          "waitAfterName": ""
        }
      ],
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "id": "ret",
      "kind": "atomic",
      "name": "Return",
      "color": "#f472b6",
      "locked": false,
      "endPoint": {
        "x": 30.75,
        "y": 30.75
      },
      "controlPoints": [],
      "heading": {
        "type": "tangential",
        "reverse": true
      },
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    }
  ],
  "shapes": [],
  "sequence": [
    {
      "kind": "path",
      "lineId": "out-1"
    },
    {
      "kind": "path",
      "lineId": "out-2"
    },
    {
      "kind": "path",
      "lineId": "hook"
    },
    {
      "kind": "path",
      "lineId": "garden-1"
    },
    {
      "kind": "path",
      "lineId": "garden-2"
    },
    {
      "kind": "wait",
      "id": "w-intake",
      "name": "Intake settle",
      "durationMs": 1000
    },
    {
      "kind": "path",
      "lineId": "ret"
    }
  ],
  "settings": {
    "xVelocity": 75,
    "yVelocity": 65,
    "aVelocity": 3.141592653589793,
    "kFriction": 0.1,
    "rWidth": 17,
    "rHeight": 16.5,
    "safetyMargin": 1,
    "maxVelocity": 40,
    "maxAcceleration": 30,
    "maxDeceleration": 30,
    "fieldMap": "biobuzz.webp"
  },
  "version": "1.5.0",
  "timestamp": "2026-09-27T15:10:00.000Z"
}
