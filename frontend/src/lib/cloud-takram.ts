import { BlendFunction, Effect, EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing'
import { Data3DTexture, HalfFloatType, LinearFilter, LoadingManager, PerspectiveCamera, RedFormat, RepeatWrapping, Scene, TextureLoader, Vector3, WebGLRenderer } from 'three'
import type { Texture, WebGLRenderTarget } from 'three'
import { CloudsEffect } from '@takram/three-clouds'
import { PrecomputedTexturesLoader } from '@takram/three-atmosphere'
import type { CloudLabSettings } from '@/lib/cloud-lab'
import type { CloudRuntime } from '@/lib/cloud-renderers'

export async function createTakramClouds(canvas:HTMLCanvasElement, initial:CloudLabSettings, signal:AbortSignal):Promise<CloudRuntime> {
  const renderer=new WebGLRenderer({canvas,alpha:true,premultipliedAlpha:false,antialias:false,depth:false,powerPreference:'low-power'})
  renderer.setClearColor(0,0)
  renderer.toneMappingExposure=10
  renderer.setPixelRatio(1)
  const scene=new Scene(), camera=new PerspectiveCamera(55,16/9,10,1e6)
  // ECEF: +x is up at longitude 0 / latitude 0. The cloud engine uses
  // planetary coordinates; only the sky's transparent layer is composited.
  camera.position.set(6378137+250,0,0)
  camera.up.set(1,0,0)
  camera.lookAt(camera.position.clone().add(new Vector3(.08,0,-1)))
  const effect=new CloudsEffect(camera)
  effect.skipRendering=false
  effect.blendMode.blendFunction=BlendFunction.SRC
  effect.turbulence=false
  effect.qualityPreset='medium'
  effect.resolutionScale=.65
  effect.temporalUpscale=true
  effect.lightShafts=false
  effect.haze=false
  effect.shadow.cascadeCount=1
  effect.shadow.mapSize.set(128,128)
  effect.clouds.maxIterationCount=320
  effect.clouds.minStepSize=25
  effect.clouds.accurateSunSkyLight=true
  effect.clouds.maxRayDistance=90000
  effect.cloudLayers[3].densityScale=0
  if(initial.candidate==='takram-soft') {
    effect.cloudLayers[0].densityScale=0
    effect.cloudLayers[1].densityScale=0
    effect.cloudLayers[2].set({ altitude:2600,height:450,densityScale:.04,shapeAmount:.55,shapeDetailAmount:.1 })
  } else {
    effect.cloudLayers[0].set({ altitude:1100,height:750,densityScale:.18 })
    effect.cloudLayers[1].set({ altitude:1500,height:1100,densityScale:.12 })
    effect.cloudLayers[2].densityScale=0
  }
  const composer=new EffectComposer(renderer,{frameBufferType:HalfFloatType,multisampling:0})
  composer.addPass(new RenderPass(scene,camera))
  // CloudsEffect emits premultiplied radiance. Decode it before tone mapping
  // and browser straight-alpha compositing, avoiding bright cloud outlines.
  const straightAlpha=new Effect('CloudStraightAlpha',`void mainImage(const vec4 c,const vec2 uv,out vec4 o){o=vec4(c.a>0.0001?c.rgb/c.a:vec3(0.),c.a);}`,{blendFunction:BlendFunction.SRC})
  composer.addPass(new EffectPass(camera,effect,straightAlpha,new ToneMappingEffect({mode:ToneMappingMode.AGX})))
  const textures:Texture[]=[]
  let disposed=false
  const dispose=()=>{
    if(disposed)return
    disposed=true
    // Upstream internal render targets aren't owned by Effect.dispose().
    for(const pass of [effect.cloudsPass,effect.shadowPass]) {
      for(const resource of Object.values(pass)) {
        if(resource && typeof resource==='object' && 'isWebGLRenderTarget' in resource) (resource as WebGLRenderTarget).dispose()
      }
      pass.dispose()
    }
    composer.dispose()
    textures.forEach(texture=>texture.dispose())
    renderer.dispose()
    queueMicrotask(()=>{if(!canvas.isConnected)renderer.forceContextLoss()})
  }
  signal.addEventListener('abort',dispose,{once:true})
  const controller=new AbortController()
  signal.addEventListener('abort',()=>controller.abort(),{once:true})
  try {
    const manager=new LoadingManager()
    const atmosphere=await new Promise<Record<string,Texture>>((resolve,reject)=>{
      const loaded=new PrecomputedTexturesLoader({format:'binary',higherOrderScattering:false},manager).load('/scenes/cloud-lab/atmosphere',values=>resolve(values as unknown as Record<string,Texture>),undefined,reject)
      // These texture instances exist before their I/O completes.
      for(const texture of Object.values(loaded))if(texture)textures.push(texture)
    })
    signal.throwIfAborted()
    Object.assign(effect,atmosphere)
    const weather=await new TextureLoader().loadAsync('/scenes/cloud-lab/local_weather.png')
    if(disposed){weather.dispose();signal.throwIfAborted()}
    textures.push(weather)
    weather.wrapS=weather.wrapT=RepeatWrapping
    effect.localWeatherTexture=weather
    const loadVolume=async(name:string,size:number)=>{
      const response=await fetch('/scenes/cloud-lab/'+name,{signal:controller.signal})
      if(!response.ok)throw new Error('Cloud texture '+response.status)
      const data=new Uint8Array(await response.arrayBuffer())
      signal.throwIfAborted()
      const texture=new Data3DTexture(data,size,size,size)
      texture.format=RedFormat;texture.minFilter=texture.magFilter=LinearFilter
      texture.wrapS=texture.wrapT=texture.wrapR=RepeatWrapping
      texture.unpackAlignment=1;texture.needsUpdate=true;textures.push(texture)
      return texture
    }
    effect.shapeTexture=await loadVolume('shape.bin',128)
    effect.shapeDetailTexture=await loadVolume('shape_detail.bin',32)
    let jitterSeed=4187
    const jitterData=Uint8Array.from({length:32*32*32},()=>{
      jitterSeed=(Math.imul(jitterSeed,1664525)+1013904223)>>>0
      return jitterSeed>>>24
    })
    const jitter=new Data3DTexture(jitterData,32,32,32)
    jitter.format=RedFormat;jitter.needsUpdate=true;textures.push(jitter)
    effect.stbnTexture=jitter
    signal.throwIfAborted()
    let width=0,height=0
    return {render(value,_time,delta){
      if(disposed)return
      const w=Math.max(1,Math.round(canvas.clientWidth)),h=Math.max(1,Math.round(canvas.clientHeight))
      if(width!==w||height!==h){width=w;height=h;renderer.setSize(w,h,false);composer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix()}
      const angle=value.scene==='morning'?.30:value.scene==='dusk'?.12:value.scene==='night'?-.1:.95
      effect.sunDirection.set(Math.sin(angle),.35,-Math.cos(angle)).normalize()
      effect.coverage=.08+value.density/100*.36
      effect.localWeatherVelocity.set(.0014,0)
      effect.shapeVelocity.set(.0004,0,0)
      canvas.style.opacity=String(value.density===0?0:value.scene==='night'?.40:1)
      composer.render(delta)
    },dispose}
  } catch(error){dispose();throw error}
}
