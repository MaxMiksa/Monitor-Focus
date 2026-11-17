export function createPainter(canvas) {
    const ctx = canvas.getContext('2d')
    // Paint the tapered streak once; each particle needs only one blit per frame.
    const streak = document.createElement('canvas')
    streak.width = 32
    streak.height = 80
    const ink = streak.getContext('2d'),
        gradient = ink.createLinearGradient(28, 0, 3, 80)
    gradient.addColorStop(0, 'rgba(219,234,249,0)')
    gradient.addColorStop(0.35, 'rgba(219,234,249,.2)')
    gradient.addColorStop(0.78, 'rgba(219,234,249,.9)')
    gradient.addColorStop(1, 'rgba(219,234,249,0)')
    ink.fillStyle = gradient
    ink.beginPath()
    ink.ellipse(16, 40, 3, 41, 0.33, 0, Math.PI * 2)
    ink.fill()
    return {
        begin(w, h) {
            ctx.clearRect(0, 0, w, h)
            ctx.lineCap = 'round'
            ctx.strokeStyle = '#dbeaf9'
            ctx.fillStyle = '#e3f4fc'
        },
        rain(p) {
            ctx.globalAlpha = p.alpha * Math.min(1, p.age * 8, (p.life - p.age) * 6)
            ctx.drawImage(
                streak,
                p.x - p.width / 2,
                p.y - p.length,
                p.width - (p.dx / p.v) * p.length,
                p.length,
            )
        },
        water(p, sx) {
            ctx.globalAlpha = 0.8 * (1 - p.age / p.life)
            if (p.arc) {
                const r = p.size * (0.75 + (0.45 * p.age) / p.life) * 0.4
                ctx.lineWidth = Math.max(0.55, sx)
                ctx.beginPath()
                ctx.moveTo(p.x - r, p.y)
                ctx.quadraticCurveTo(p.x - r, p.y - r, p.x, p.y)
                ctx.quadraticCurveTo(p.x + r * 0.5, p.y - r * 1.4, p.x + r, p.y)
                ctx.stroke()
            } else {
                ctx.beginPath()
                ctx.arc(p.x, p.y, p.size * 0.24, 0, Math.PI * 2)
                ctx.fill()
            }
        },
        end() {
            ctx.globalAlpha = 1
        },
        dispose() {},
    }
}
