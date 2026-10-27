{
  "startPoint": {
    "x": 56,
    "y": 8,
    "headingDeg": 90,
    "locked": false
  },
  "lines": [
    {
      "id": "line-mukxeo3a-y7xtvp",
      "color": "#ffc516",
      "name": "Path 1",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 500,
      "waitBeforeName": "",
      "waitAfterName": "",
      "kind": "atomic",
      "endPoint": {
        "x": 56,
        "y": 36
      },
      "controlPoints": [],
      "heading": {
        "type": "linear",
        "startDeg": 90,
        "endDeg": 180
      }
    },
    {
      "kind": "compound",
      "id": "line-mukxeqdk-sn20j8",
      "name": "",
      "color": "#8CB767",
      "segments": [
        {
          "kind": "atomic",
          "id": "line-mukxepkk-vo198z",
          "endPoint": {
            "x": 30,
            "y": 60
          },
          "controlPoints": [
            {
              "x": 40,
              "y": 40
            }
          ],
          "heading": {
            "type": "tangential",
            "reverse": true
          },
          "color": "#8CB767",
          "locked": false,
          "waitBeforeMs": 0,
          "waitAfterMs": 0,
          "waitBeforeName": "",
          "waitAfterName": ""
        },
        {
          "kind": "atomic",
          "id": "line-mukxepxw-lly4u4",
          "endPoint": {
            "x": 60,
            "y": 100
          },
          "controlPoints": [],
          "heading": {
            "type": "tangential",
            "reverse": true
          },
          "color": "#A7BBB9",
          "locked": false,
          "waitBeforeMs": 0,
          "waitAfterMs": 0,
          "waitBeforeName": "",
          "waitAfterName": ""
        }
      ],
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": "",
      "heading": {
        "type": "linear",
        "reverse": false,
        "startDeg": 0,
        "endDeg": 90
      }
    },
    {
      "kind": "atomic",
      "id": "line-mukxeqv8-q9job1",
      "endPoint": {
        "x": 100,
        "y": 110
      },
      "controlPoints": [
        {
          "x": 80,
          "y": 130
        }
      ],
      "heading": {
        "type": "piecewise",
        "reverse": true,
        "piecewiseHeading": {
          "segments": [
            {
              "startProgress": 0,
              "endProgress": 0.3,
              "interpolationType": "tangential",
              "reversed": true,
              "continueFromPrevious": false
            },
            {
              "startProgress": 0.3,
              "endProgress": 0.6,
              "interpolationType": "constant",
              "reversed": false,
              "continueFromPrevious": true,
              "parameters": {
                "degrees": 0
              }
            },
            {
              "startProgress": 0.6,
              "endProgress": 0.8,
              "interpolationType": "linear",
              "reversed": true,
              "continueFromPrevious": false,
              "parameters": {
                "startDeg": 90,
                "endDeg": 180
              }
            },
            {
              "startProgress": 0.8,
              "endProgress": 1,
              "interpolationType": "facing-point",
              "reversed": false,
              "continueFromPrevious": false,
              "parameters": {
                "point": {
                  "x": 120,
                  "y": 120
                }
              }
            }
          ]
        }
      },
      "color": "#DACAAD",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "kind": "compound",
      "id": "line-mukxevcp-du16sl",
      "name": "",
      "color": "#D8A5BA",
      "segments": [
        {
          "kind": "atomic",
          "id": "line-mukxetzc-3gbp2a",
          "endPoint": {
            "x": 120,
            "y": 80
          },
          "controlPoints": [],
          "heading": {
            "type": "constant",
            "reverse": true,
            "degrees": 30
          },
          "color": "#D8A5BA",
          "locked": false,
          "waitBeforeMs": 0,
          "waitAfterMs": 0,
          "waitBeforeName": "",
          "waitAfterName": ""
        },
        {
          "kind": "atomic",
          "id": "line-mukxeugc-oq81u6",
          "endPoint": {
            "x": 110,
            "y": 40
          },
          "controlPoints": [
            {
              "x": 135,
              "y": 55
            }
          ],
          "heading": {
            "type": "linear",
            "reverse": true,
            "startDeg": 30,
            "endDeg": -60
          },
          "color": "#BCDCBB",
          "locked": false,
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
    },
    {
      "id": "triangle-2",
      "name": "Blue Goal",
      "vertices": [
        {
          "x": 6.2,
          "y": 116.9
        },
        {
          "x": 25,
          "y": 141.5
        },
        {
          "x": 0,
          "y": 141.5
        },
        {
          "x": 0,
          "y": 70
        },
        {
          "x": 6,
          "y": 70
        }
      ],
      "color": "#2563eb",
      "fillColor": "#60a5fa"
    }
  ],
  "sequence": [
    {
      "kind": "path",
      "lineId": "line-mukxeo3a-y7xtvp"
    },
    {
      "kind": "path",
      "lineId": "line-mukxepkk-vo198z"
    },
    {
      "kind": "path",
      "lineId": "line-mukxepxw-lly4u4"
    },
    {
      "kind": "path",
      "lineId": "line-mukxeqv8-q9job1"
    },
    {
      "kind": "path",
      "lineId": "line-mukxetzc-3gbp2a"
    },
    {
      "kind": "path",
      "lineId": "line-mukxeugc-oq81u6"
    }
  ],
  "fieldPoints": [],
  "activePaths": [],
  "settings": {
    "xVelocity": 75,
    "yVelocity": 65,
    "aVelocity": 3.141592653589793,
    "kFriction": 0.1,
    "rWidth": 16,
    "rHeight": 16,
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
    "leftPanelWidth": 0,
    "rightPanelWidth": 616,
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
  "timestamp": "2026-09-28T07:28:45.229Z"
}