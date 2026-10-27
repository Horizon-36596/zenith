{
  "startPoint": {
    "x": 56,
    "y": 8,
    "headingDeg": 90,
    "locked": false
  },
  "lines": [
    {
      "id": "line-mukx8qan-b174mh",
      "color": "#ffc516",
      "name": "Path 1",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
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
      "kind": "atomic",
      "id": "line-mukx8s0j-38syyz",
      "endPoint": {
        "x": 30,
        "y": 60
      },
      "controlPoints": [
        {
          "x": 20,
          "y": 40
        }
      ],
      "heading": {
        "type": "constant",
        "reverse": true,
        "degrees": 45
      },
      "color": "#BBBC95",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "kind": "atomic",
      "id": "line-mukx8swv-6wt4kt",
      "endPoint": {
        "x": 60,
        "y": 100
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
      "heading": {
        "type": "tangential",
        "reverse": false
      },
      "color": "#B78BD8",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "kind": "atomic",
      "id": "line-mukx8u0c-upoiaw",
      "endPoint": {
        "x": 100,
        "y": 110
      },
      "controlPoints": [],
      "heading": {
        "type": "tangential",
        "reverse": true
      },
      "color": "#698995",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "kind": "atomic",
      "id": "line-mukx8uaw-cyrp33",
      "endPoint": {
        "x": 110,
        "y": 60
      },
      "controlPoints": [
        {
          "x": 120,
          "y": 105
        },
        {
          "x": 130,
          "y": 90
        },
        {
          "x": 95,
          "y": 80
        },
        {
          "x": 125,
          "y": 70
        }
      ],
      "heading": {
        "type": "linear",
        "reverse": true,
        "startDeg": -90,
        "endDeg": 90
      },
      "color": "#8D799B",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "kind": "atomic",
      "id": "line-mukx8w6v-yl9sv3",
      "endPoint": {
        "x": 110,
        "y": 30
      },
      "controlPoints": [],
      "heading": {
        "type": "linear",
        "reverse": true,
        "startDeg": 170,
        "endDeg": -170
      },
      "color": "#9D58B8",
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
      "lineId": "line-mukx8qan-b174mh"
    },
    {
      "kind": "path",
      "lineId": "line-mukx8s0j-38syyz"
    },
    {
      "kind": "path",
      "lineId": "line-mukx8swv-6wt4kt"
    },
    {
      "kind": "path",
      "lineId": "line-mukx8u0c-upoiaw"
    },
    {
      "kind": "path",
      "lineId": "line-mukx8uaw-cyrp33"
    },
    {
      "kind": "path",
      "lineId": "line-mukx8w6v-yl9sv3"
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
  "timestamp": "2026-09-28T07:24:06.992Z"
}