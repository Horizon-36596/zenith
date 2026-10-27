{
  "startPoint": { "x": 20, "y": 30, "heading": "linear", "startDeg": 0, "endDeg": 45, "locked": false },
  "lines": [
    {
      "id": "line-a",
      "name": "Path 1",
      "endPoint": { "x": 44, "y": 30, "heading": "linear", "startDeg": 0, "endDeg": 45 },
      "controlPoints": [],
      "color": "#5A8FD6",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    },
    {
      "id": "line-b",
      "name": "Path 2",
      "endPoint": { "x": 60, "y": 50, "heading": "tangential", "reverse": false },
      "controlPoints": [{ "x": 58, "y": 32 }],
      "color": "#D6A55A",
      "locked": false,
      "waitBeforeMs": 0,
      "waitAfterMs": 0,
      "waitBeforeName": "",
      "waitAfterName": ""
    }
  ],
  "shapes": [],
  "sequence": [
    { "kind": "path", "lineId": "line-a" },
    { "kind": "path", "lineId": "line-b" }
  ],
  "pathChains": [{ "id": "chain-a", "name": "Chain 1", "color": "#5A8FD6", "lineIds": ["line-a", "line-b"] }],
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
    "theme": "dark",
    "showGhostPaths": false,
    "showOnionLayers": false,
    "onionLayerSpacing": 3,
    "onionColor": "#dc2626",
    "onionNextPointOnly": false,
    "showHeadingArrow": false,
    "headingArrowLength": 50,
    "headingArrowColor": "#ffffff",
    "headingArrowThickness": 2,
    "pathOpacity": 1
  },
  "version": "1.2.1",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
