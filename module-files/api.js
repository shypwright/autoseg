// @flow

module.exports = (WASM_INIT) => {
  let wasm = WASM_INIT()

  function isWasmLoaded() {
    return Boolean(wasm.setImageSize) // any property works
  }

  const mod = { unresolvedCalls: [] }

  async function resolveCalls() {
    while (mod.unresolvedCalls.length > 0) {
      const { f, args, resolve, reject } = mod.unresolvedCalls[0]
      mod.unresolvedCalls.shift()
      await f(...args)
        .then(resolve)
        .catch(reject)
    }
  }

  function eventuallyResolve(f) {
    return (...args) => {
      if (isWasmLoaded()) {
        return resolveCalls().then(() => {
          return f(...args)
        })
      } else {
        return new Promise((resolve, reject) => {
          mod.unresolvedCalls.push({ f, args, resolve, reject })
        })
      }
    }
  }

  let checkWasmLoadedInterval = setInterval(() => {
    if (isWasmLoaded()) {
      clearInterval(checkWasmLoadedInterval)
      resolveCalls()
    }
  }, 100)

  mod.defaultConfig = {
    mode: "autoseg",
    maxClusters: 1000,
    classColors: [
      0x88000000,
      2285257716,
      2297665057,
      2286989132,
      2281729263,
      2286441849,
      2285412200,
      2288197353,
      2293245852,
      2293584191,
      2290652672,
      2285493453,
      2290842976,
    ],
    classNames: [],
  }
  mod.config = { ...mod.defaultConfig }

  mod.setConfig = eventuallyResolve(async (config) => {
    mod.config = { ...mod.defaultConfig, ...config }
  })
  mod.loadImage = eventuallyResolve(async (imageData) => {
    wasm.setSimpleMode(mod.config.mode === "simple")
    wasm.setMaxClusters(mod.config.maxClusters)
    wasm.setImageSize(imageData.width, imageData.height)
    mod.config.imageSize = { width: imageData.width, height: imageData.height }
    for (let i = 0; i < mod.config.classColors.length; i++) {
      wasm.setClassColor(i, mod.config.classColors[i])
    }
    const imageAddress = wasm.getImageAddr()
    wasm.HEAPU8.set(imageData.data, imageAddress)
    wasm.computeSuperPixels()
    mod.imageLoaded = true
  })
  mod.getMask = eventuallyResolve(async (objects) => {
    wasm.clearClassElements()
    const { width, height } = mod.config.imageSize
    // convert bounding boxes to polygons
    objects = objects.map((r) => {
      if (r.regionType !== "bounding-box") return r
      return {
        regionType: "polygon",
        cls: r.cls,
        points: [
          { x: r.x, y: r.y },
          { x: r.x + r.w, y: r.y },
          { x: r.x + r.w, y: r.y + r.h },
          { x: r.x, y: r.y + r.h },
        ],
      }
    })
    for (let object of objects) {
      const clsIndex =
        typeof object.cls === "number"
          ? object.cls
          : mod.config.classNames.indexOf(object.cls)
      if (clsIndex > mod.config.classColors.length || clsIndex === -1) {
        continue
      }

      switch (object.regionType) {
        case "polygon": {
          const { points } = object
          const pi = wasm.addPolygon(clsIndex)
          const pointPairs = points.map((p, i) => [
            p,
            points[(i + 1) % points.length],
          ])
          for (const [p1, p2] of pointPairs) {
            const ri1 = Math.round(p1.y * height)
            const ci1 = Math.round(p1.x * width)
            const ri2 = Math.round(p2.y * height)
            const ci2 = Math.round(p2.x * width)
            wasm.addLineToPolygon(pi, ri1, ci1, ri2, ci2)
          }
          break
        }
        case "point": {
          const { x, y } = object
          if (x < 0 || x >= 1) continue
          if (y < 0 || y >= 1) continue

          wasm.addClassPoint(
            clsIndex,
            Math.floor(y * mod.config.height),
            Math.floor(x * mod.config.width)
          )
          break
        }
        default: {
          continue
        }
      }
    }

    wasm.computeMasks()
    const maskAddress = wasm.getColoredMask()
    const cppImDataUint8 = new Uint8ClampedArray(
      wasm.HEAPU8.buffer,
      maskAddress,
      width * height * 4
    )

    if (typeof ImageData !== "undefined") {
      // Browser
      return new ImageData(cppImDataUint8, width, height)
    } else {
      // NodeJS
      return { data: cppImDataUint8, width, height }
    }
  })

  return mod
}