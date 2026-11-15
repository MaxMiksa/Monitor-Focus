import { Color, DataTexture, LinearFilter, RedFormat, RepeatWrapping, ShaderMaterial } from 'three'

// Restored from the pre-particle stage (6fe1bc6). Keep its four-octave noise
// and three warped veil layers; make density affect contrast as well as alpha.
export function createLegacyMaterial() {
  let seed = 20261114
  const random = () => { seed = (Math.imul(seed,1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const octaves = [4,7,13,29].map((cells,index) => ({ cells, grid: Float32Array.from({ length: cells*cells },random), weight: [.42,.28,.18,.12][index] }))
  const size = 128, data = new Uint8Array(size*size)
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
    let value=0
    for (const { cells,grid,weight } of octaves) {
      const gx=(x+.5)/size*cells, gy=(y+.5)/size*cells
      const ix=Math.floor(gx), iy=Math.floor(gy), tx=gx-ix, ty=gy-iy
      const u=tx*tx*(3-2*tx), v=ty*ty*(3-2*ty)
      const a=grid[iy*cells+ix]*(1-u)+grid[iy*cells+(ix+1)%cells]*u
      const b=grid[(iy+1)%cells*cells+ix]*(1-u)+grid[(iy+1)%cells*cells+(ix+1)%cells]*u
      value+=(a*(1-v)+b*v)*weight
    }
    data[y*size+x]=Math.round(Math.max(0,Math.min(1,.5+(value-.5)*1.55))*255)
  }
  const noise=new DataTexture(data,size,size,RedFormat)
  noise.wrapS=noise.wrapT=RepeatWrapping
  noise.minFilter=noise.magFilter=LinearFilter
  noise.needsUpdate=true
  const material=new ShaderMaterial({ transparent:true, depthWrite:false, depthTest:false, toneMapped:false,
    uniforms:{ airNoise:{value:noise},phase:{value:0},density:{value:.65},tint:{value:new Color('#ffffff')} },
    vertexShader:`varying vec2 vUv; void main(){ vUv=vec2(position.x*.5+.5,.5-position.y*.5); gl_Position=vec4(position.xy,0.,1.); }`,
    fragmentShader:`
      uniform sampler2D airNoise; uniform float phase,density; uniform vec3 tint; varying vec2 vUv;
      float veilLayer(vec2 p,float seed,float harmonic){
        float a=phase*harmonic+seed;
        vec2 orbit=vec2(sin(a),cos(a+seed*.31))*.035;
        vec2 warpUv=p*.43+vec2(.17+seed*.07,.61-seed*.05)+orbit*.45;
        vec2 warp=vec2(texture2D(airNoise,warpUv).r,texture2D(airNoise,warpUv+vec2(.27,.43)-orbit*.30).r)-.5;
        float stretch=1.+.13*sin(a+1.1);
        float gather=.38+.13*sin(a*2.+seed)+.07*cos(a+p.x*3.1);
        vec2 q=(p+warp*(.14+.060*sin(a*3.)))*stretch+orbit;
        float shape=smoothstep(gather,gather+.44,texture2D(airNoise,q).r);
        float veil=.30+.70*smoothstep(.08,.72,shape);
        float transmittance=.74+.26*sin(phase*(harmonic+2.)+p.x*4.+p.y*6.+seed);
        float dissolve=.76+.24*sin(phase*(harmonic+1.)+p.y*2.2-seed);
        return veil*transmittance*dissolve;
      }
      void main(){
        vec2 p1=vec2(vUv.x*1.42+vUv.y*.31,vUv.y*5.8-vUv.x*.18)+vec2(.12,.27);
        vec2 p2=mat2(.93,-.36,.36,.93)*vec2(vUv.x*2.15-vUv.y*.44,vUv.y*8.+vUv.x*.26)+vec2(.47,.13);
        vec2 p3=mat2(.80,.60,-.60,.80)*vec2(vUv.x*2.85+vUv.y*.55,vUv.y*10.6-vUv.x*.33)+vec2(.71,.63);
        float wisps=veilLayer(p1,.7,1.)*.46+veilLayer(p2,2.4,2.)*.33+veilLayer(p3,4.1,3.)*.21;
        // Old density was attenuated by luma, daytime and multiple calm masks;
        // its tint also blended toward the existing sky. Avoid multiplying all
        // those attenuations again: white light and stronger cloud separation.
        float shape=smoothstep(mix(.39,.20,density),.73,wisps);
        float horizon=1.-smoothstep(.43,.69,vUv.y);
        float alpha=shape*(1.-exp(-density*3.2))*horizon;
        gl_FragColor=vec4(tint,alpha);
      }`,
  })
  return { material,noise }
}
