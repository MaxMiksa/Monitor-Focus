import { BackSide, BoxGeometry, Color, Data3DTexture, GLSL3, Group, LinearFilter, Mesh, RawShaderMaterial, RedFormat } from 'three'
import type { PerspectiveCamera } from 'three'
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js'
import { volumeVertex, volumeFragment } from '@/lib/cloud-volume-shaders'
import type { CloudLabSettings } from '@/lib/cloud-lab'

// The official Three.js cloud example, reused as three small sky volumes.
export function createVolumeClouds() {
  const size=64, data=new Uint8Array(size*size*size), noise=new ImprovedNoise()
  let index=0
  for(let z=0;z<size;z++) for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const d=1-Math.hypot(x-size/2,y-size/2,z-size/2)/size
    data[index++]=(128+128*noise.noise(x*.1/1.5,y*.1,z*.1/1.5))*d*d
  }
  const texture=new Data3DTexture(data,size,size,size)
  texture.format=RedFormat; texture.minFilter=texture.magFilter=LinearFilter; texture.unpackAlignment=1; texture.needsUpdate=true
  const geometry=new BoxGeometry(1,1,1)
  const material=new RawShaderMaterial({ glslVersion:GLSL3, transparent:true, depthWrite:false, side:BackSide,
    vertexShader:volumeVertex, fragmentShader:volumeFragment,
    uniforms:{base:{value:new Color('#cbd4df')},map:{value:texture},cameraPos:{value:{x:0,y:0,z:18}},threshold:{value:.28},range:{value:.095},opacity:{value:.20},steps:{value:72},frame:{value:0}},
  })
  const group=new Group()
  const meshes=Array.from({length:3},(_,i)=>{
    const mesh=new Mesh(geometry,material)
    mesh.position.set((i-1)*6.2,2.9+(i%2)*1.2,-2-i*.5)
    mesh.scale.set(7.6,3.1,3.5)
    group.add(mesh)
    return mesh
  })
  return {group,resources:[texture,geometry,material],update(value:CloudLabSettings,time:number,camera:PerspectiveCamera){
    material.uniforms.cameraPos.value=camera.position
    material.uniforms.base.value.set(value.scene==='dusk'?'#dba28b':value.scene==='night'?'#556a96':'#cbd4df')
    material.uniforms.threshold.value=.35-value.density*.0014
    material.uniforms.frame.value++
    meshes.forEach((mesh,i)=>{mesh.position.x=(i-1)*6.2+Math.sin(time*.12+i)*.8; mesh.rotation.y=Math.sin(time*.08+i)*.18})
  }}
}
