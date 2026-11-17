import React, { lazy, Suspense, useEffect, useRef } from 'react'
import { cloudPlacements } from '@/lib/cloud-placement'
import { cloudPosition } from '@/lib/cloud-motion'

const Legacy = lazy(() => import('@/components/sky-canvas').then((m) => ({ default: m.SkyCanvas })))
const tint = { morning: '#fff1dc', midday: '#eef8ff', dusk: '#ffbb9a', night: '#7583b0' }
function cloudCards(settings) {
    const puff = settings.style === 'puffs',
        volume = puff ? 3.2 : settings.style === 'layers' ? 1.8 : 1.15
    const cards = []
    for (let g = 0; g < 3; g++) {
        let s = 142 + 31 * g
        const random = () => {
            const n = Math.sin(s++) * 10000
            return n - Math.floor(n)
        }
        for (let i = 0; i < 24; i++) {
            const density = Math.max(0.5, random())
            random()
            const u = random() * 2 - 1,
                v = random() * 2 - 1,
                q = random() * 2 - 1,
                x = u * (puff ? 2.5 : 5.2),
                y = v * (puff ? 0.8 : 0.12),
                z = q * 0.4
            const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z))
            cards.push({
                g,
                x,
                y,
                z,
                density,
                size:
                    volume * Math.max(0.25, 1 - Math.abs(m === Math.abs(x) ? u : m === Math.abs(y) ? v : q)),
                angle: puff ? (-i * Math.PI) / 24 : 0.025 - i * 0.002,
            })
        }
    }
    return cards
}
function projectedStars(n, w, h, f) {
    // Fixed camera: discard points outside the view once, not on every tick.
    let seed = 61341
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
    const visible = []
    for (let i = 0; i < n; i++) {
        const radius = 110 - (20 * i) / Math.max(1, n),
            y = 2 * rand() - 1,
            a = rand() * Math.PI * 2,
            r = Math.sqrt(1 - y * y) * radius
        const depth = 9 - r * Math.cos(a),
            u = w / 2 + (f * r * Math.sin(a)) / depth,
            v = h / 2 - (f * radius * y) / depth
        const size = ((0.5 + 0.5 * rand()) * 4 * 30 * (3 + Math.sin(100))) / depth
        const phase = rand() * Math.PI * 2,
            speed = 0.55 + 1.65 * rand(),
            amp = 0.25 + 0.65 * rand()
        if (depth > 0 && u >= -4 && v >= -4 && u <= w + 4 && v <= h + 4)
            visible.push({ u, v, size: Math.max(1, size), phase, speed, amp })
    }
    return visible
}
function FlatSky({ scene, settings, reduced }) {
    const ref = useRef(null)
    useEffect(() => {
        const canvas = ref.current,
            ctx = canvas.getContext('2d'),
            dpr = Math.min(devicePixelRatio || 1, 1.25)
        const s = settings.stars,
            c = settings.clouds,
            n =
                s.enabled && s.brightness > 0
                    ? Math.round(((s.style === 'dense' ? 18000 : 1800) * s.count) / 100)
                    : 0
        const cloudy = c.enabled && c.density > 0,
            placements = cloudPlacements(c, scene),
            cards = cloudy ? cloudCards(c) : []
        const img = cloudy ? new Image() : null
        let sprite = null,
            stars = [],
            w = 0,
            h = 0,
            f = 0,
            clock = 0,
            prev = performance.now(),
            timer = 0,
            dead = false
        const dot = document.createElement('canvas')
        dot.width = dot.height = 24
        if (n) {
            const dc = dot.getContext('2d'),
                grad = dc.createRadialGradient(12, 12, 0, 12, 12, 12)
            for (let i = 0; i <= 8; i++) {
                const t = i / 8
                grad.addColorStop(t, 'rgba(255,255,255,' + 1 / (1 + Math.exp(16 * (t * 0.5 - 0.25))) + ')')
            }
            dc.fillStyle = grad
            dc.fillRect(0, 0, 24, 24)
        }
        function resize() {
            const W = canvas.clientWidth,
                H = canvas.clientHeight
            if (!W || !H || (W === w && H === h)) return
            w = W
            h = H
            canvas.width = Math.round(w * dpr)
            canvas.height = Math.round(h * dpr)
            f = Math.max(h, (w * 941) / 1672) / (2 * Math.tan(Math.PI / 10))
            stars = projectedStars(n, w, h, f)
        }
        function render() {
            clearTimeout(timer)
            if (dead || document.hidden) return
            const now = performance.now()
            if (!reduced) clock += Math.min(0.2, (now - prev) / 1000)
            prev = now
            resize()
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            ctx.clearRect(0, 0, w, h)
            ctx.fillStyle = '#fff'
            ctx.globalCompositeOperation = 'lighter'
            for (const p of stars) {
                const light =
                    ((0.9 * s.brightness) / 100) *
                    (1 -
                        (reduced ? 0 : s.twinkle / 100) *
                            p.amp *
                            (0.5 + 0.5 * Math.sin(clock * p.speed + p.phase)))
                ctx.globalAlpha = light < 0.0031308 ? 12.92 * light : 1.055 * light ** (1 / 2.4) - 0.055
                // A one-pixel point samples the center of the old star texture; don't
                // average an entire dot into one pixel, which erases the faint stars.
                if (p.size <= 1.25)
                    ctx.fillRect(Math.floor(p.u * dpr) / dpr, Math.floor(p.v * dpr) / dpr, 1 / dpr, 1 / dpr)
                else {
                    const d = p.size / dpr
                    ctx.drawImage(dot, p.u - d / 2, p.v - d / 2, d, d)
                }
            }
            ctx.globalCompositeOperation = 'source-over'
            if (sprite) {
                const t = (clock * c.speed) / 100
                const groups = placements.map((p) =>
                    cloudPosition(p, t, c.motion, (w * 0.5 * (18 - p.z)) / f),
                )
                ctx.globalAlpha = (c.density / 100) * (c.style === 'wisps' ? 0.38 : 0.7)
                for (const p of cards) {
                    const g = groups[p.g],
                        scale = f / (18 - placements[p.g].z - p.z)
                    const d =
                        scale *
                        (p.size +
                            (1 + Math.sin(((t * p.density * c.speed) / 100) * 0.35)) *
                                0.5 *
                                (c.style === 'puffs' ? 0.65 : 0.22))
                    ctx.save()
                    ctx.translate(w * 0.5 + (g.x + p.x) * scale, h * 0.5 - (g.y + p.y) * scale)
                    ctx.rotate(p.angle)
                    ctx.drawImage(sprite, -d / 2, -d / 2, d, d)
                    ctx.restore()
                }
            }
            ctx.globalAlpha = 1
            canvas.dataset.ready = 'true'
            canvas.dataset.starCount = String(n)
            if (!reduced && ((sprite && c.speed > 0) || (n && s.twinkle > 0))) timer = setTimeout(render, 50)
        }
        if (img) {
            img.onload = () => {
                if (dead) return
                const tex = document.createElement('canvas')
                tex.width = img.width
                tex.height = img.height
                const tc = tex.getContext('2d')
                tc.drawImage(img, 0, 0)
                tc.globalCompositeOperation = 'multiply'
                tc.fillStyle = tint[scene]
                tc.fillRect(0, 0, tex.width, tex.height)
                tc.globalCompositeOperation = 'destination-in'
                tc.drawImage(img, 0, 0)
                sprite = tex
                render()
            }
            img.src = '/scenes/live/cloud.png'
        }
        const observer = new ResizeObserver(render)
        observer.observe(canvas)
        document.addEventListener('visibilitychange', render)
        render()
        return () => {
            dead = true
            clearTimeout(timer)
            observer.disconnect()
            document.removeEventListener('visibilitychange', render)
            if (img) {
                img.onload = null
                img.removeAttribute('src')
            }
        }
    }, [settings, scene, reduced])
    return <canvas ref={ref} className="sky-effects-canvas" aria-hidden="true" />
}
export function SkyCanvas(props) {
    // Preserve the old noise veil for now; don't substitute a different cloud style.
    return props.settings.clouds.enabled &&
        props.settings.clouds.density > 0 &&
        props.settings.clouds.style === 'legacy' ? (
        <Suspense fallback={null}>
            <Legacy {...props} />
        </Suspense>
    ) : (
        <FlatSky {...props} />
    )
}
