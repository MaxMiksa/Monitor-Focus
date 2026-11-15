# 雨景选型预览

仅用于浏览器选型，不进入软件正式包，不接天气、定位或硬件。

在本目录运行 `npm ci --ignore-scripts`，然后 `npm start`，访问 http://127.0.0.1:5194。
场景直接使用现有本地资源；比较 tsParticles 和 three.quarks 的不同雨景配置，而非声称每个预设是独立组件。切换销毁旧效果；同一时间只运行一个。强度统一为 0–100，后续可由天气降雨量驱动，当前仅手动。

来源与许可证：

- tsParticles 4.5.3，MIT：https://github.com/tsparticles/tsparticles
- three.quarks 0.17.1，MIT：https://github.com/Alchemist0823/three.quarks
- Three.js 0.187.0，MIT：https://github.com/mrdoob/three.js

页面呈现帧率与粒子数量，不把 JS 堆或纹理数误称为软件总内存。最终选定后需在原生面板重新比较开销。

