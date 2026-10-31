# 天气汇 · WeatherHub

[![Android](https://img.shields.io/badge/Android-6.0%2B-3DDC84?style=flat-square&logo=android&logoColor=white)](https://developer.android.com)
[![Offline Build](https://img.shields.io/badge/build-aapt%20%2B%20javac%20%2B%20d8-blueviolet?style=flat-square)](#构建)
[![No SDK](https://img.shields.io/badge/Gradle-not%20required-ff69b4?style=flat-square)](#构建)

一个 **多源天气聚合 Android App**：自动获取当前城市，同时从 **4 个天气平台**（中国气象局、Open-Meteo、MET Norway、wttr.in）抓取数据，给出**综合结论**与**各平台独立详情**。

> APK 下载：[dist/WeatherHub-1.0.0.apk](dist/WeatherHub-1.0.0.apk)（已签名，Android 6.0+）

## ✨ 功能

- **自动定位城市**：原生 GPS（运行时权限）→ IP 定位多源兜底（ipinfo / ipwho.is / api.ipapi.is）→ 默认城市；也支持中文城市搜索（中国气象局站号库 + Open-Meteo Geocoding）。
- **多源天气聚合**
  | 平台 | 类型 | 说明 |
  |---|---|---|
  | 中国气象局 CMA | 官方 | 中国气象局站号数据，含 7 天预报与气象预警 |
  | Open-Meteo | 模型 | ECMWF/GFS 数据，逐小时 + 7 天 + 空气质量（CAMS） |
  | MET Norway (Yr) | 模型 | 北欧气象局全球预报，逐小时 |
  | wttr.in | 聚合 | World Weather Online 数据，3 天 |
  | 和风天气 / OpenWeatherMap | 可选 | 设置里填入自己的 API Key 后启用 |
- **综合算法**：温度/体感/湿度/风速/气压/UV/能见度/降水取多源**中位数**（自动剔除离群值）；天气现象按**加权投票**（官方源权重更高）；输出**一致度百分比**与「高/中/低」分歧提示；逐时与 7 天按时间对齐后跨源合并。
- **各平台独立详情**：每个源展示自己的实时数据、逐时与 7 天预报、请求延迟；支持单源重试/刷新；失败不影响其它源。
- **界面**：深色玻璃拟态、随天气/昼夜变化的动态背景、大号温度与数字滚动、SVG 温度曲线与降水概率、7 天温度区间条、多源温度对比、空气质量卡、预警卡、下拉刷新、骨架屏、离线缓存与时效提示。
- **隐私**：无后端、无账号、无埋点；定位只在本机解析；API Key 仅保存在本机 localStorage。

## 🧱 技术架构

```
┌─────────────────────────────── Android WebView (https://app.local) ───────────────────────────────┐
│  原生 JS 单页应用（app/）：bridge.js · sources.js · aggregate.js · location.js · ui.js · app.js  │
│        │ window.AndroidApp(JS Bridge)                                                              │
│  ┌─────▼─────────────────────────────────────────────────────────────────────────────────────┐    │
│  │ MainActivity / NativeBridge / AssetServer（纯 Java，无 AndroidX / 无 Gradle）               │    │
│  │  · HttpURLConnection 异步请求（线程池、超时、重定向）    · LocationManager 定位 + 运行时权限  │    │
│  │  · shouldInterceptRequest 从 assets 提供静态资源（正确 MIME/UTF-8）                        │    │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- 前端零依赖、零构建：普通 `<script>` 顺序加载，内联 SVG 图标与图表，离线可打包进 APK。
- 网络请求全部走**原生桥**，绕开 WebView 的 CORS 限制；桥接口带超时、错误结构化和日志环形缓冲。
- 构建完全手写：`aapt`(v1) → `javac` → `d8`(R8) → `zipalign` → `apksigner`，**不需要 Android SDK / Gradle**，适合在手机上的 aarch64 Ubuntu 里构建。

## 📁 目录结构

```
app/                     # 打进 APK 的 Web 资源
  index.html
  css/style.css
  js/{bridge,sources,aggregate,location,ui,app}.js
android/                 # 原生壳
  AndroidManifest.xml
  src/com/deepseek/weatherhub/{MainActivity,NativeBridge,AssetServer}.java
  res/  keystore/
build.sh                 # 一键构建签名 APK
tools/                   # 图标生成、预览服务器、截图/冒烟脚本、发布脚本
tests/                   # 数据层单元测试 + UI 冒烟测试
dist/                    # 构建产物（APK）
```

## 🔨 构建

依赖（Ubuntu/Debian aarch64 或 x86 均可）：

```bash
sudo apt-get install -y openjdk-17-jdk-headless aapt zipalign apksigner unzip zip curl
# d8 从 Maven 获取（项目已约定 tools/lib/r8.jar）：
curl -L -o tools/lib/r8.jar \
  https://maven.aliyun.com/repository/google/com/android/tools/r8/8.9.35/r8-8.9.35.jar
# android.jar（API 23 即可）：
sudo apt-get install -y android-sdk-platform-23
```

```bash
./build.sh                # → build/WeatherHub-1.0.0.apk
apksigner verify --print-certs build/WeatherHub-1.0.0.apk
```

## 🧪 本地预览 / 测试

```bash
node tools/dev-server.mjs                 # http://127.0.0.1:8099/?proxy=1（真实数据，带 CORS 代理）
node tools/dev-server.mjs                 # http://127.0.0.1:8099/?mock=1 （离线 mock 数据）
node tools/screenshot.mjs                 # headless Chromium 4 个 Tab 截图 → build/shots/
node tests/ui-smoke.mjs                   # UI 冒烟断言（console error / 横向溢出 / Tab 切换）
node tests/fetch-sources.mjs              # 真实抓取 4 个平台并打印归一化结果
node tests/aggregate-test.mjs             # 聚合算法单元测试
```

## 🙏 数据来源

- [中国气象局 · 天气网](https://weather.cma.cn/)（官方数据）
- [Open-Meteo](https://open-meteo.com/)（CC BY 4.0）· [空气质量 CAMS](https://open-meteo.com/en/docs/air-quality-api)
- [MET Norway · Yr](https://www.met.no/en)(NLOD / CC BY 4.0)
- [wttr.in](https://wttr.in/)（World Weather Online）
- [ipinfo.io](https://ipinfo.io/) · [ipwho.is](https://ipwho.is/) · [ipapi.is](https://api.ipapi.is) · [BigDataCloud](https://www.bigdatacloud.com/)（IP 定位 / 逆地理）

数据版权归各平台所有，本应用仅做聚合展示。

## 📄 License

[MIT](LICENSE)

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
