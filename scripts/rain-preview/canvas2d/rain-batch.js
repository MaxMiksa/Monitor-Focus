// Flat ink sprites in screen pixels. No camera, depth buffer, scene graph or textures.
export function createPainter(canvas) {
    const gl = canvas.getContext('webgl', {
        alpha: true,
        depth: false,
        stencil: false,
        antialias: false,
        powerPreference: 'low-power',
    })
    if (!gl) throw Error('2D batch unavailable')
    function compile(type, src) {
        const sh = gl.createShader(type)
        gl.shaderSource(sh, src)
        gl.compileShader(sh)
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(sh))
        return sh
    }
    const program = gl.createProgram()
    for (const [type, src] of [
        [
            gl.VERTEX_SHADER,
            `
    attribute vec4 rect; attribute vec4 ink; uniform vec2 viewport;
    varying vec4 v; varying float kind; varying float diameter;
    void main(){gl_Position=vec4(rect.xy/viewport*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);
      gl_PointSize=rect.z;diameter=rect.z;kind=rect.w;v=ink;}`,
        ],
        [
            gl.FRAGMENT_SHADER,
            `
    precision mediump float;varying vec4 v;varying float kind;varying float diameter;
    void main(){
      vec2 uv=gl_PointCoord;float a;
      if(kind<.5){float y=uv.y;float profile=sqrt(max(0.,1.-pow(2.*y-1.,2.)));
        float d=abs((uv.x-.5+(y-.5)*v.z)*diameter);
        float fade=y<.35?mix(0.,.2,y/.35):y<.78?mix(.2,.9,(y-.35)/.43):.9*(1.-y)/.22;
        a=clamp(.5+v.y*.5*profile-d,0.,1.)*fade;
      }else if(kind<1.5){a=1.-smoothstep(.04,.5,length(uv-.5));}
      else{float x=uv.x*2.-1.;float bend=4.*abs(x)*(1.-abs(x));
        float line=.64-bend*(x>0.?.31:.22);
        a=clamp(.6+v.y*.5-abs(uv.y-line)*diameter,0.,1.)*smoothstep(0.,.08,1.-abs(x));}
      gl_FragColor=vec4(.87,.94,.99,v.x*a);
    }`,
        ],
    ]) {
        const sh = compile(type, src)
        gl.attachShader(program, sh)
        gl.deleteShader(sh)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program))
    gl.useProgram(program)
    const data = new Float32Array((2400 + 144 + 24) * 8),
        buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW)
    for (const [key, offset] of [
        ['rect', 0],
        ['ink', 16],
    ]) {
        const a = gl.getAttribLocation(program, key)
        gl.enableVertexAttribArray(a)
        gl.vertexAttribPointer(a, 4, gl.FLOAT, false, 32, offset)
    }
    const viewport = gl.getUniformLocation(program, 'viewport')
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    let n = 0
    function point(x, y, d, k, a, width, tilt) {
        data[n++] = x
        data[n++] = y
        data[n++] = d
        data[n++] = k
        data[n++] = a
        data[n++] = width
        data[n++] = tilt
        n++
    }
    return {
        begin(w, h) {
            n = 0
            gl.viewport(0, 0, w, h)
            gl.uniform2f(viewport, w, h)
            gl.clear(gl.COLOR_BUFFER_BIT)
        },
        rain(p) {
            const tilt = -p.dx / p.v
            point(
                p.x + p.length * tilt * 0.5,
                p.y - p.length * 0.5,
                p.length,
                0,
                p.alpha * Math.min(1, p.age * 8, (p.life - p.age) * 6),
                p.width,
                tilt,
            )
        },
        water(p, sx) {
            point(
                p.x,
                p.y,
                Math.max(1, p.arc ? p.size * (0.75 + (0.45 * p.age) / p.life) * 0.8 : p.size),
                p.arc ? 2 : 1,
                0.8 * (1 - p.age / p.life),
                Math.max(0.55, sx),
                0,
            )
        },
        end() {
            if (n) {
                gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, n))
                gl.drawArrays(gl.POINTS, 0, n / 8)
            }
        },
        dispose() {
            gl.deleteBuffer(buffer)
            gl.deleteProgram(program)
            gl.getExtension('WEBGL_lose_context')?.loseContext()
        },
    }
}
