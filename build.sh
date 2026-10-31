#!/usr/bin/env bash
# =============================================================================
# 天气汇 WeatherHub — 手写 APK 构建流水线（无 Gradle / 无 AndroidX / 无 aapt2）
#
#   清理 -> 图标/keystore -> R.java(aapt v1) -> javac(Java 8, android.jar)
#        -> d8(r8.jar) -> 资源+assets 基础 APK(aapt) -> 塞 classes.dex
#        -> zipalign -> apksigner(v1+v2) -> verify + badging 摘要
#
# 输出：build/WeatherHub-<version>.apk
# 依赖：java javac keytool aapt zipalign apksigner python3 node（r8.jar 缺失自动下载）
# 幂等：重复执行安全；build/ 只清理自己的中间产物。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

trap 'echo "BUILD FAILED (line $LINENO): $BASH_COMMAND" >&2' ERR

ANDROID_DIR="$ROOT/android"
APP_DIR="$ROOT/app"
BUILD="$ROOT/build"
GEN="$BUILD/gen"
CLASSES="$BUILD/classes"
DEX="$BUILD/dex"
TMP="$BUILD/tmp"
ASSETS="$BUILD/assets"
SRC_LIST="$TMP/sources.txt"

# android.jar 路径（默认 apt 的 android-sdk-platform-23）
ANDROID_JAR="/usr/lib/android-sdk/platforms/android-23/android.jar"
R8_JAR="$ROOT/tools/lib/r8.jar"
R8_VERSION="8.9.35"
R8_URL="https://maven.aliyun.com/repository/google/com/android/tools/r8/$R8_VERSION/r8-$R8_VERSION.jar"
KEYSTORE="$ANDROID_DIR/keystore/weatherhub.keystore"
KEY_ALIAS="weatherhub"
KEY_PASS="weatherhub123"
MIN_SDK=23
TARGET_SDK=34

info()  { printf '\033[36m[build]\033[0m %s\n' "$*"; }
ok()    { printf '\033[32m[ ok ]\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
fail()  { printf '\033[31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1（请让 Lead 安装工具链）"
}

# ---------------------------------------------------------------- 0. 环境检查
info "检查工具链"
need_cmd java
need_cmd javac
need_cmd keytool
need_cmd aapt
need_cmd zipalign
need_cmd apksigner
need_cmd python3
[ -f "$ANDROID_JAR" ] || fail "android.jar 不存在：$ANDROID_JAR"
[ -f "$ANDROID_DIR/AndroidManifest.xml" ] || fail "AndroidManifest.xml 缺失"

VERSION="$(grep -o 'android:versionName="[^"]*"' "$ANDROID_DIR/AndroidManifest.xml" | head -n1 | sed 's/.*="//; s/"$//' || true)"
if [ -z "$VERSION" ]; then VERSION="1.0.0"; fi
VERSION_CODE="$(grep -o 'android:versionCode="[^"]*"' "$ANDROID_DIR/AndroidManifest.xml" | head -n1 | sed 's/.*="//; s/"$//' || true)"
if [ -z "$VERSION_CODE" ]; then VERSION_CODE="1"; fi
OUT_APK="$BUILD/WeatherHub-$VERSION.apk"
info "版本 $VERSION (code $VERSION_CODE)  android.jar=$ANDROID_JAR"

# d8 来自 maven 的 r8.jar（apt 没有 aarch64 d8）；缺失则自动下载
if [ ! -s "$R8_JAR" ] || [ "$(stat -c%s "$R8_JAR")" -lt 2000000 ]; then
  info "下载 r8.jar ($R8_VERSION) -> tools/lib/r8.jar"
  need_cmd node
  mkdir -p "$ROOT/tools/lib"
  node - "$R8_URL" "$R8_JAR" <<'NODE' || fail "r8.jar 下载失败（检查网络或手动放置 tools/lib/r8.jar）"
const https = require('https');
const fs = require('fs');
const url = process.argv[2];
const out = process.argv[3];
function attempt(n, cb) {
  const tmp = out + '.part';
  const req = https.get(url, { timeout: 120000 }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      r.resume();
      return attempt(n, cb);
    }
    if (r.statusCode !== 200) { r.resume(); return cb(new Error('HTTP ' + r.statusCode)); }
    const f = fs.createWriteStream(tmp);
    r.pipe(f);
    f.on('finish', () => f.close(() => { fs.renameSync(tmp, out); cb(null); }));
    r.on('error', (e) => { try { f.close(); } catch (_) {} cb(e); });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (e) => { if (n < 2) { setTimeout(() => attempt(n + 1, cb), 1000); } else { cb(e); } });
}
attempt(0, (err) => {
  if (err) { console.error('download failed:', err.message); process.exit(1); }
  console.log('r8.jar downloaded:', fs.statSync(out).size, 'bytes');
});
NODE
fi
[ -s "$R8_JAR" ] || fail "r8.jar 不可用：$R8_JAR"
info "r8.jar: $(du -h "$R8_JAR" | cut -f1)"

# ---------------------------------------------------------------- 1. 清理
info "清理临时目录"
mkdir -p "$BUILD" "$TMP"
rm -rf "$GEN" "$CLASSES" "$DEX" "$ASSETS"
rm -f "$BUILD/base.apk" "$BUILD/unsigned.apk" "$BUILD/aligned.apk" "$OUT_APK"
mkdir -p "$GEN" "$CLASSES" "$DEX" "$ASSETS"

# ---------------------------------------------------------------- 2. 图标 + keystore
if [ ! -f "$ANDROID_DIR/res/mipmap-mdpi/ic_launcher.png" ] || [ ! -f "$ANDROID_DIR/res/mipmap-xxxhdpi/ic_launcher.png" ]; then
  info "生成启动图标（5 个密度）"
  python3 "$ROOT/tools/gen_icons.py"
else
  info "启动图标已存在，跳过生成"
fi

if [ ! -f "$KEYSTORE" ]; then
  info "生成 demo keystore（alias=$KEY_ALIAS，密码 $KEY_PASS，36500 天）"
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair \
    -keystore "$KEYSTORE" -storetype PKCS12 -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 36500 \
    -storepass "$KEY_PASS" -keypass "$KEY_PASS" \
    -dname "CN=WeatherHub, O=DeepSeek, OU=WeatherHub, C=CN" -noprompt >/dev/null
  ok "keystore 已生成：$KEYSTORE"
fi

# ---------------------------------------------------------------- 3. assets
# app/ 是 Web 资源目录；UI/数据层可能尚未产出，先用占位页保证可构建。
info "准备 assets（来源 app/）"
if [ -d "$APP_DIR" ]; then
  cp -a "$APP_DIR/." "$ASSETS/" 2>/dev/null || true
fi
if [ ! -f "$ASSETS/index.html" ]; then
  warn "app/index.html 不存在，使用占位页（Web 层就绪后重新 ./build.sh 即可）"
  cat > "$ASSETS/index.html" <<'HTML'
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>天气汇</title>
  <style>
    html,body{margin:0;height:100%;background:#0b1020;color:#e8eeff;
      font-family:system-ui,-apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif}
    #app{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px}
    .logo{font-size:30px;font-weight:700;letter-spacing:2px}
    .hint{opacity:.62;font-size:13px;text-align:center;line-height:1.7;padding:0 28px}
  </style>
</head>
<body>
  <div id="app">
    <div class="logo">天气汇</div>
    <div class="hint">Web 资源尚未打包<br>请运行 ./build.sh 重新构建 APK</div>
  </div>
</body>
</html>
HTML
fi
ASSET_COUNT="$(find "$ASSETS" -type f | wc -l | tr -d ' ')"
info "assets 文件数：$ASSET_COUNT"

# ---------------------------------------------------------------- 4. R.java
info "aapt package -m 生成 R.java"
aapt package -f -m -J "$GEN" \
  -M "$ANDROID_DIR/AndroidManifest.xml" \
  -S "$ANDROID_DIR/res" \
  -I "$ANDROID_JAR"

# ---------------------------------------------------------------- 5. javac
info "javac 编译 Java 源码"
find "$ANDROID_DIR/src" "$GEN" -name '*.java' -print > "$SRC_LIST"
[ -s "$SRC_LIST" ] || fail "没有找到 Java 源码"
javac -source 8 -target 8 \
  -bootclasspath "$ANDROID_JAR" \
  -classpath "$ANDROID_JAR" \
  -encoding UTF-8 -nowarn -Xlint:-options \
  -d "$CLASSES" \
  @"$SRC_LIST"
CLASS_COUNT="$(find "$CLASSES" -name '*.class' | wc -l | tr -d ' ')"
ok "编译完成：$CLASS_COUNT 个 class"

# ---------------------------------------------------------------- 6. d8
info "d8 生成 classes.dex（min-api $MIN_SDK）"
find "$CLASSES" -name '*.class' -print0 | xargs -0 \
  java -Xmx512m -cp "$R8_JAR" com.android.tools.r8.D8 \
    --release --min-api "$MIN_SDK" \
    --lib "$ANDROID_JAR" \
    --output "$DEX/" 2>&1 | sed 's/^/  /'
[ -f "$DEX/classes.dex" ] || fail "d8 未生成 classes.dex"
ok "classes.dex: $(du -h "$DEX/classes.dex" | cut -f1)"

# ---------------------------------------------------------------- 7. 基础 APK
info "aapt package 生成资源 + manifest + assets APK"
aapt package -f \
  -M "$ANDROID_DIR/AndroidManifest.xml" \
  -S "$ANDROID_DIR/res" \
  -A "$ASSETS" \
  -I "$ANDROID_JAR" \
  -F "$BUILD/base.apk"

# ---------------------------------------------------------------- 8. 塞 classes.dex
info "把 classes.dex 加入 APK 根目录"
cp "$BUILD/base.apk" "$BUILD/unsigned.apk"
if command -v zip >/dev/null 2>&1; then
  ( cd "$DEX" && zip -qj "$BUILD/unsigned.apk" classes.dex )
else
  ( cd "$DEX" && aapt add "$BUILD/unsigned.apk" classes.dex )
fi
BUILD_STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---------------------------------------------------------------- 9. 对齐 + 签名
info "zipalign 4 字节对齐"
zipalign -f 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"

info "apksigner 签名（v1+v2，alias=$KEY_ALIAS）"
apksigner sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KEY_PASS" \
  --key-pass "pass:$KEY_PASS" \
  --min-sdk-version "$MIN_SDK" \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --out "$OUT_APK" \
  "$BUILD/aligned.apk"
[ -f "$OUT_APK" ] || fail "签名后 APK 不存在"

# ---------------------------------------------------------------- 10. 校验
info "apksigner verify"
apksigner verify --verbose --print-certs "$OUT_APK" 2>&1 | sed 's/^/  /'

info "aapt dump badging 摘要"
BADGING="$(aapt dump badging "$OUT_APK")"
printf '%s\n' "$BADGING" | grep -E "^(package:|sdkVersion:|targetSdkVersion:|application-label:|application:)" | sed 's/^/  /' || true
printf '%s\n' "$BADGING" | grep -E "^uses-permission:" | sed 's/^/  /' || true

info "APK 内容检查"
if command -v unzip >/dev/null 2>&1; then
  unzip -l "$OUT_APK" | grep -E "index.html|classes.dex|resources.arsc|AndroidManifest.xml|mipmap-.*/ic_launcher.png" | sed 's/^/  /' || true
fi

APK_SIZE="$(stat -c%s "$OUT_APK")"
APK_SHA="$(sha256sum "$OUT_APK" | cut -d' ' -f1)"
echo
ok "构建完成（UTC $BUILD_STAMP）"
echo "APK OK $OUT_APK $APK_SIZE"
echo "APK SHA256 $APK_SHA"
echo "APK 版本 $VERSION ($VERSION_CODE)，minSdk $MIN_SDK, targetSdk $TARGET_SDK"
