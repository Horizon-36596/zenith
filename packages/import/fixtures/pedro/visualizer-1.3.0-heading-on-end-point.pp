{
  "startPoint": {
    "x": 56,
    "y": 8,
    "heading": "linear",
    "startDeg": 90,
    "endDeg": 180,
    "locked": false
  },
  "lines": [
    {
      "id": "line-22hzs3fw5w5",
      "name": "Path 1",
      "endPoint": {
        "x": 56,
        "y": 36,
        "heading": "linear",
        "startDeg": 90,
        "endDeg": 180
      },
      "controlPoints": [],
      "color": "#D69A58",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "id": "line-aulhdarmper",
      "endPoint": {
        "x": 30,
        "y": 60,
        "heading": "constant",
        "reverse": true,
        "degrees": 45
      },
      "controlPoints": [
        {
          "x": 20,
          "y": 40
        }
      ],
      "color": "#D69A58",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "id": "line-q8m0dw7ib9s",
      "endPoint": {
        "x": 60,
        "y": 100,
        "heading": "tangential",
        "reverse": false
      },
      "controlPoints": [
        {
          "x": 20,
          "y": 80
        },
        {
          "x": 40,
          "y": 110
        }
      ],
      "color": "#D69A58",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "id": "line-i5a02bz385n",
      "endPoint": {
        "x": 100,
        "y": 110,
        "heading": "tangential",
        "reverse": true
      },
      "controlPoints": [],
      "color": "#D69A58",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "id": "line-6ymhocd6pzg",
      "endPoint": {
        "x": 110,
        "y": 60,
        "heading": "linear",
        "reverse": true,
        "startDeg": 170,
        "endDeg": -170
      },
      "controlPoints": [],
      "color": "#D69A58",
      "locked": false,
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
      "lineId": "line-22hzs3fw5w5"
    },
    {
      "kind": "path",
      "lineId": "line-aulhdarmper"
    },
    {
      "kind": "path",
      "lineId": "line-q8m0dw7ib9s"
    },
    {
      "kind": "path",
      "lineId": "line-i5a02bz385n"
    },
    {
      "kind": "path",
      "lineId": "line-6ymhocd6pzg"
    }
  ],
  "pathChains": [
    {
      "id": "chain-mukxm8fg-o8k3b2",
      "name": "Main Chain",
      "color": "#D69A58",
      "lineIds": [
        "line-22hzs3fw5w5",
        "line-aulhdarmper",
        "line-q8m0dw7ib9s",
        "line-i5a02bz385n",
        "line-6ymhocd6pzg"
      ]
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
    "fieldMap": "decode.webp",
    "robotImage": "/robot.png",
    "theme": "auto",
    "showGhostPaths": false,
    "showOnionLayers": false,
    "onionLayerSpacing": 3,
    "onionColor": "#dc2626",
    "onionNextPointOnly": false,
    "showHeadingArrow": false,
    "headingArrowLength": 50,
    "headingArrowColor": "#ffffff",
    "headingArrowThickness": 2,
    "pathOpacity": 1,
    "rightPanelMinWidth": 0,
    "penToolAccuracy": 8,
    "experimentalFeatures": {
      "optimize": false,
      "curveThrough": false
    }
  },
  "version": "1.3.0",
  "timestamp": "2026-09-28T07:34:33.127Z"
}