import { createPainter } from './rain-painter.js'
// Fixed-view sprite simulation. Positions and collision edges are in CSS pixels.
const layers = [
    [-7, 11, 0.035, 200, 670, 0.38],
    [0, 15, 0.045, 115, 300, 0.48],
    [5, 18, 0.052, 30, 65, 0.5],
]
const roofs = {
    live: [[722, 945, 378, 378]],
    classic: [
        [540, 1015, 356, 382],
        [1124, 1368, 541, 535],
    ],
}
const rand = (a, b) => a + (b - a) * Math.random()
export function createWindRain(host, report) {
    const canvas = document.createElement('canvas')
    canvas.dataset.effect = 'wind-splash'
    host.append(canvas)
    const painter = createPainter(canvas)
    const rain = [],
        water = [],
        freeRain = [],
        freeWater = [],
        carry = [0, 0, 0]
    let amount = 0.75,
        paused = true,
        disposed = false,
        on = true,
        timer = 0,
        time = 0,
        last = 0,
        statsAt = 0,
        frames = 0,
        lastFps = 0
    let provider = () => [],
        w = 0,
        h = 0,
        bg = 'live',
        sx = 1,
        ox = 0,
        oy = 0,
        roof = true,
        hits = 0,
        edgeHits = 0,
        arcs = 0
    const machineHits = [0, 0],
        edges = []
    function clear() {
        rain.length = water.length = freeRain.length = freeWater.length = 0
        arcs = 0
        carry.fill(0)
        painter.begin(w, h)
    }
    function resize() {
        w = Math.max(1, host.clientWidth)
        h = Math.max(1, host.clientHeight)
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w
            canvas.height = h
            clear()
        }
        const sw = bg === 'live' ? 1672 : 1920,
            sh = bg === 'live' ? 941 : 1080
        sx = Math.max(w / sw, h / sh)
        ox = (w - sw * sx) / 2
        oy = (h - sh * sx) / 2
    }
    function targets() {
        const ui = provider()
        const b = ui.background === 'classic' ? 'classic' : 'live'
        if (bg !== b) {
            bg = b
            clear()
            resize()
            machineHits.fill(0)
        }
        roof = !ui.settingsOpen
        edges.length = 0
        if (roof)
            for (const [i, r] of roofs[bg].entries())
                edges.push([ox + r[0] * sx, ox + r[1] * sx, oy + r[2] * sx, oy + r[3] * sx, i])
        for (const e of ui) edges.push([e.left, e.right, e.top, e.top, -1])
        if (!roof) for (const p of water) if (p.machine) p.life = 0
    }
    function splash(x, y, machine, arc) {
        if (!on || (arc ? arcs >= 24 : water.length - arcs >= 144)) return
        const p = freeWater.pop() ?? {}
        Object.assign(p, {
            x,
            y: y - (arc ? 4 * sx : 0),
            vx: rand(-100, 40) * sx,
            vy: -rand(95, 160) * sx,
            size: (arc ? rand(20, 30) : rand(4, 7)) * sx,
            age: 0,
            life: arc ? rand(0.2, 0.28) : rand(0.3, 0.44),
            machine,
            arc,
        })
        if (arc) arcs++
        water.push(p)
    }
    function draw(dt) {
        targets()
        painter.begin(w, h)
        time += dt
        const focal = h / (2 * Math.tan(Math.PI / 10))
        layers.forEach(([z, speed, size, base, extra, alpha], k) => {
            carry[k] += (base * amount + extra * amount ** 3) * dt
            while (carry[k] >= 1) {
                carry[k]--
                if (rain.length >= 2400) continue
                const d = focal / (18 - z - rand(-1, 1)),
                    v = d * speed * rand(0.85, 1.15),
                    p = freeRain.pop() ?? {}
                const spread = Math.random(),
                    worldSize = size * rand(0.65, 1.25)
                Object.assign(p, {
                    x: w / 2 + (3 + rand(-18, 18) * spread) * d,
                    y: h / 2 - (10 + rand(-0.1, 0.1) * spread) * d,
                    v,
                    dx: -0.36 * v,
                    width: worldSize * d,
                    length: worldSize * v * 0.85,
                    alpha: alpha * rand(0.65, 1),
                    age: 0,
                    life: rand(1.65, 2),
                    z,
                })
                rain.push(p)
            }
        })
        for (let i = rain.length - 1; i >= 0; i--) {
            const p = rain[i]
            p.age += dt
            if (p.age >= p.life || p.y > h + 45 || p.x < -30) {
                rain[i] = rain[rain.length - 1]
                rain.pop()
                freeRain.push(p)
                continue
            }
            const x = p.x,
                y = p.y
            p.dx += ((Math.sin(time * 0.8 + p.z) * dt * focal) / (18 - p.z)) * 0.7
            p.x += p.dx * dt
            p.y += p.v * dt
            for (const [l, r, t, b, id] of edges) {
                const slope = (b - t) / Math.max(1, r - l),
                    from = y - t - (x - l) * slope,
                    to = p.y - t - (p.x - l) * slope
                if (from > 0 || to < 0 || to <= from) continue
                const f = -from / (to - from),
                    hit = x + (p.x - x) * f
                if (hit < l || hit > r) continue
                hits++
                if (id < 0) edgeHits++
                else machineHits[id]++
                if (Math.random() < 0.35) {
                    splash(hit, y + (p.y - y) * f, id >= 0, false)
                    splash(hit, y + (p.y - y) * f, id >= 0, false)
                }
                if (Math.random() < 0.18) splash(hit, y + (p.y - y) * f, id >= 0, true)
            }
            if (p.y < 0 || p.x > w + 35) continue
            painter.rain(p)
        }
        for (let i = water.length - 1; i >= 0; i--) {
            const p = water[i]
            p.age += dt
            if (p.age >= p.life) {
                if (p.arc) arcs--
                water[i] = water[water.length - 1]
                water.pop()
                freeWater.push(p)
                continue
            }
            if (!p.arc) {
                p.vy += 650 * sx * dt
                p.vx -= 35 * sx * dt
                p.x += p.vx * dt
                p.y += p.vy * dt
            }
            painter.water(p, sx)
        }
        painter.end()
    }
    function publish() {
        Object.assign(canvas.dataset, {
            rain: rain.length,
            splash: water.length,
            arcs,
            hits,
            uiHits: edgeHits,
            machineHits: machineHits.slice(0, roofs[bg].length).join(','),
            roofEnabled: roof,
            roofSplash: water.filter((p) => p.machine && p.age < p.life).length,
        })
        report(rain.length, lastFps, water.length)
    }
    function tick() {
        if (disposed || paused || document.hidden) return
        const now = performance.now()
        draw(Math.min(0.06, (now - last) / 1000))
        last = now
        frames++
        if (now - statsAt > 600) {
            lastFps = Math.round((frames * 1000) / (now - statsAt))
            statsAt = now
            frames = 0
            publish()
        }
        timer = setTimeout(tick, Math.max(0, 1000 / 30 - (performance.now() - now)))
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    return {
        setEdges(f) {
            provider = f
        },
        refreshEdges() {
            targets()
            publish()
        },
        setAmount(v) {
            amount = Math.max(0, Math.min(1, v))
            if (!amount) clear()
        },
        setSplashes(v) {
            on = v
            if (!v) {
                water.length = 0
                arcs = 0
            }
        },
        setPaused(v) {
            clearTimeout(timer)
            paused = v
            if (!v) {
                last = statsAt = performance.now()
                frames = 0
                tick()
            }
        },
        dispose() {
            disposed = true
            clearTimeout(timer)
            observer.disconnect()
            clear()
            painter.dispose()
            canvas.remove()
        },
    }
}
