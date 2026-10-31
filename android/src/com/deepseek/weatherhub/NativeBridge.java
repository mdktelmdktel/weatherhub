package com.deepseek.weatherhub;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.Charset;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 原生桥：暴露给 JS 的 window.AndroidApp（@JavascriptInterface）。
 *
 * 契约见 SPEC.md 第 5 节：
 *   httpFetch(reqId, url, headersJson, timeoutMs) -> window.__nativeHttpDone(reqId, resultJson)
 *   getLocation(reqId)                           -> window.__nativeLocation(reqId, resultJson)
 *   toast(msg) / deviceInfo() / openUrl(url) / log(level, msg) / getLogs()
 *
 * 所有网络请求走 HttpURLConnection（不依赖 Play 服务/OkHttp），线程池固定 4 线程。
 * 回调统一通过 webView.post(...) + evaluateJavascript 回到页面主线程。
 */
public class NativeBridge {

    private static final String TAG = "WeatherHubNative";
    private static final String DEFAULT_UA = "WeatherHub/1.0 (Android)";
    private static final int MAX_BODY_BYTES = 2 * 1024 * 1024; // 响应体上限 2MB
    private static final int MAX_LOG_ENTRIES = 200;            // 日志环容量
    private static final int MAX_TEXT_CHARS = 4000;
    private static final int LOCATION_TIMEOUT_MS = 20000;      // 定位超时 20s
    private static final int PERM_REQ_LOCATION = 0x5748;       // 'WH'
    private static final long LAST_KNOWN_FRESH_MS = 5 * 60 * 1000L;

    private static final Object LOG_LOCK = new Object();
    private static final ArrayDeque<String> LOG_RING = new ArrayDeque<String>();

    private final Activity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService pool;
    private final LocationManager locationManager;

    /** JS 致命错误监听（供 MainActivity 显示原生错误页）。 */
    public interface FatalErrorListener {
        void onFatalError(String message);
    }

    private final List<String> pendingLocationReqs = new ArrayList<String>();
    private FatalErrorListener fatalErrorListener;
    private LocationListener locationListener;
    private Runnable locationTimeoutRunnable;
    private boolean locationInFlight;
    private boolean permissionRequested;
    private boolean permissionDenied;
    private volatile boolean released;

    public NativeBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        final AtomicInteger seq = new AtomicInteger(1);
        this.pool = Executors.newFixedThreadPool(4, new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "weatherhub-http-" + seq.getAndIncrement());
                t.setDaemon(true);
                return t;
            }
        });
        LocationManager lm;
        try {
            lm = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
        } catch (Throwable t) {
            lm = null;
        }
        this.locationManager = lm;
        appendLog("info", "bridge ready (Android " + Build.VERSION.RELEASE + ")");
    }

    // ---------------------------------------------------------------- 日志环

    /** 写入原生日志环（供调试面板 getLogs 使用），最多保留 200 条。 */
    public static void appendLog(String level, String msg) {
        String lv = (level == null || level.length() == 0) ? "info" : level.toLowerCase(Locale.US);
        String text = msg == null ? "" : msg;
        if (text.length() > MAX_TEXT_CHARS) {
            text = text.substring(0, MAX_TEXT_CHARS) + "…";
        }
        String entry;
        try {
            JSONObject o = new JSONObject();
            o.put("t", System.currentTimeMillis());
            o.put("level", lv);
            o.put("msg", text);
            entry = o.toString();
        } catch (Throwable t) {
            entry = "{\"t\":0,\"level\":\"error\",\"msg\":\"log encode failed\"}";
        }
        synchronized (LOG_LOCK) {
            LOG_RING.addLast(entry);
            while (LOG_RING.size() > MAX_LOG_ENTRIES) {
                LOG_RING.removeFirst();
            }
        }
        int priority = Log.DEBUG;
        if ("error".equals(lv)) {
            priority = Log.ERROR;
        } else if ("warn".equals(lv)) {
            priority = Log.WARN;
        }
        try {
            Log.println(priority, TAG, text);
        } catch (Throwable ignored) {
        }
    }

    public static String getLogsJsonStatic() {
        StringBuilder sb = new StringBuilder("[");
        synchronized (LOG_LOCK) {
            boolean first = true;
            for (String s : LOG_RING) {
                if (!first) {
                    sb.append(',');
                }
                sb.append(s);
                first = false;
            }
        }
        sb.append(']');
        return sb.toString();
    }

    // ---------------------------------------------------------------- JS 接口

    @JavascriptInterface
    public void log(String level, String msg) {
        appendLog(level, msg);
        if (msg != null && msg.startsWith("WH_FATAL")) {
            final FatalErrorListener listener = fatalErrorListener;
            if (listener != null) {
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        if (!released) {
                            listener.onFatalError(msg);
                        }
                    }
                });
            }
        }
    }

    public void setFatalErrorListener(FatalErrorListener listener) {
        this.fatalErrorListener = listener;
    }

    @JavascriptInterface
    public String getLogs() {
        return getLogsJsonStatic();
    }

    @JavascriptInterface
    public void toast(final String msg) {
        if (msg == null || released) {
            return;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show();
                } catch (Throwable t) {
                    appendLog("warn", "toast failed: " + t);
                }
            }
        });
    }

    /** 同步返回设备信息 JSON：{model,android,appVersion,screenW,screenH,dpr} */
    @JavascriptInterface
    public String deviceInfo() {
        JSONObject o = new JSONObject();
        try {
            DisplayMetrics dm = activity.getResources().getDisplayMetrics();
            o.put("model", Build.MODEL == null ? "unknown" : Build.MODEL);
            o.put("android", Build.VERSION.RELEASE == null ? String.valueOf(Build.VERSION.SDK_INT) : Build.VERSION.RELEASE);
            o.put("appVersion", appVersionName());
            o.put("screenW", dm.widthPixels);
            o.put("screenH", dm.heightPixels);
            o.put("dpr", Math.round(dm.density * 100.0) / 100.0);
        } catch (Throwable t) {
            return "{\"model\":\"unknown\",\"android\":\"unknown\",\"appVersion\":\"1.0.0\",\"screenW\":0,\"screenH\":0,\"dpr\":1}";
        }
        return o.toString();
    }

    @JavascriptInterface
    public void openUrl(final String url) {
        if (url == null || released) {
            return;
        }
        final String u = url.trim();
        if (!(u.startsWith("https://") || u.startsWith("http://"))) {
            appendLog("warn", "openUrl rejected: " + u);
            return;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    activity.startActivity(intent);
                } catch (Throwable t) {
                    appendLog("warn", "openUrl failed: " + t);
                }
            }
        });
    }

    // ---------------------------------------------------------------- HTTP

    /**
     * 异步 GET：HttpURLConnection，跟随重定向，响应上限 2MB，UTF-8 解码。
     * 完成后回调 window.__nativeHttpDone(reqId, resultJson)。
     */
    @JavascriptInterface
    public void httpFetch(final String reqId, final String url, final String headersJson, final int timeoutMs) {
        if (reqId == null || url == null || released) {
            return;
        }
        final int timeout = clamp(timeoutMs > 0 ? timeoutMs : 12000, 1000, 30000);
        try {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    doHttpFetch(reqId, url, headersJson, timeout);
                }
            });
        } catch (Throwable t) {
            callbackHttp(reqId, errorResult("network", 0).toString());
        }
    }

    private void doHttpFetch(String reqId, String url, String headersJson, int timeoutMs) {
        long start = System.currentTimeMillis();
        HttpURLConnection conn = null;
        try {
            URL u = new URL(url);
            String proto = u.getProtocol();
            if (proto == null || !("http".equalsIgnoreCase(proto) || "https".equalsIgnoreCase(proto))) {
                callbackHttp(reqId, errorResult("bad_url", 0).toString());
                return;
            }
            conn = (HttpURLConnection) u.openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept-Encoding", "identity");
            conn.setRequestProperty("User-Agent", DEFAULT_UA);
            Map<String, String> headers = parseHeaders(headersJson);
            for (Map.Entry<String, String> e : headers.entrySet()) {
                String k = e.getKey();
                if (k == null || k.length() == 0) {
                    continue;
                }
                if ("accept-encoding".equalsIgnoreCase(k)) {
                    continue; // 固定 identity，避免拿到无法解码的压缩体
                }
                try {
                    conn.setRequestProperty(k, e.getValue());
                } catch (IllegalArgumentException badHeader) {
                    appendLog("warn", "skip bad header: " + k);
                }
            }
            int status = conn.getResponseCode();
            InputStream is = (status >= 400) ? conn.getErrorStream() : conn.getInputStream();
            byte[] body = readLimited(is, MAX_BODY_BYTES);
            String charset = charsetOf(conn.getContentType());
            String text = decode(body, charset);
            String finalUrl = conn.getURL() == null ? url : conn.getURL().toString();
            long ms = System.currentTimeMillis() - start;
            JSONObject res = new JSONObject();
            res.put("ok", status < 400);
            res.put("status", status);
            res.put("body", text);
            res.put("ms", ms);
            res.put("url", finalUrl);
            if (status >= 400) {
                res.put("error", "http_" + status);
            }
            callbackHttp(reqId, res.toString());
        } catch (SocketTimeoutException e) {
            callbackHttp(reqId, errorResult("timeout", System.currentTimeMillis() - start).toString());
        } catch (IOException e) {
            String msg = String.valueOf(e.getMessage());
            String code = msg.toLowerCase(Locale.US).contains("timeout") ? "timeout" : "network";
            callbackHttp(reqId, errorResult(code, System.currentTimeMillis() - start).toString());
        } catch (Throwable t) {
            callbackHttp(reqId, errorResult("unknown", System.currentTimeMillis() - start).toString());
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private void callbackHttp(final String reqId, final String resultJson) {
        if (released) {
            return;
        }
        final WebView wv = webView;
        if (wv == null) {
            return;
        }
        wv.post(new Runnable() {
            @Override
            public void run() {
                if (released || webView == null) {
                    return;
                }
                StringBuilder js = new StringBuilder(128);
                js.append("(function(){try{if(typeof window.__nativeHttpDone==='function'){")
                  .append("window.__nativeHttpDone(")
                  .append(JSONObject.quote(reqId))
                  .append(',')
                  .append(JSONObject.quote(resultJson))
                  .append(");}}catch(e){}})()");
                evaluate(js.toString());
            }
        });
    }

    // ---------------------------------------------------------------- 定位

    /** 异步定位：检查/申请权限 -> LocationManager -> 回调 window.__nativeLocation。 */
    @JavascriptInterface
    public void getLocation(final String reqId) {
        if (reqId == null || reqId.length() == 0 || released) {
            return;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                requestLocation(reqId);
            }
        });
    }

    /** 供 MainActivity.onRequestPermissionsResult 转发的权限结果。 */
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != PERM_REQ_LOCATION) {
            return;
        }
        boolean granted = false;
        if (grantResults != null) {
            for (int r : grantResults) {
                if (r == PackageManager.PERMISSION_GRANTED) {
                    granted = true;
                    break;
                }
            }
        }
        if (!granted) {
            permissionDenied = true;
            appendLog("warn", "location permission denied");
            finishAllPending(errorResult("permission_denied", 0));
            return;
        }
        appendLog("info", "location permission granted");
        if (locationInFlight) {
            return;
        }
        startLocationUpdates();
    }

    private boolean hasLocationPermission() {
        try {
            return activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                    || activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    private void requestLocation(String reqId) {
        if (released) {
            return;
        }
        synchronized (pendingLocationReqs) {
            pendingLocationReqs.add(reqId);
        }
        if (!hasLocationPermission()) {
            if (permissionDenied) {
                finishAllPending(errorResult("permission_denied", 0));
                return;
            }
            if (!permissionRequested) {
                permissionRequested = true;
                try {
                    activity.requestPermissions(new String[]{
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                    }, PERM_REQ_LOCATION);
                } catch (Throwable t) {
                    permissionDenied = true;
                    finishAllPending(errorResult("permission_denied", 0));
                }
            }
            return; // 等待 onRequestPermissionsResult
        }
        if (locationInFlight) {
            return; // 已有请求在跑，结果会广播给所有 pending
        }
        startLocationUpdates();
    }

    private void startLocationUpdates() {
        locationInFlight = true;
        if (locationManager == null) {
            finishAllPending(errorResult("disabled", 0));
            return;
        }
        Location last = freshestLastKnown();
        if (last != null && System.currentTimeMillis() - last.getTime() <= LAST_KNOWN_FRESH_MS) {
            appendLog("info", "location: use fresh lastKnown");
            finishWithLocation(last, "last");
            return;
        }
        boolean gpsOn = isProviderEnabled(LocationManager.GPS_PROVIDER);
        boolean networkOn = isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        if (!gpsOn && !networkOn) {
            if (last != null) {
                finishWithLocation(last, "last");
            } else {
                finishAllPending(errorResult("disabled", 0));
            }
            return;
        }
        locationListener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                if (!locationInFlight || location == null) {
                    return;
                }
                appendLog("info", "location fix: provider=" + location.getProvider());
                stopLocationUpdates();
                finishWithLocation(location, location.getProvider());
            }

            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {
            }

            @Override
            public void onProviderEnabled(String provider) {
            }

            @Override
            public void onProviderDisabled(String provider) {
            }
        };
        try {
            if (gpsOn && hasLocationPermission()) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0L, 0f, locationListener, Looper.getMainLooper());
            }
            if (networkOn && hasLocationPermission()) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 0L, 0f, locationListener, Looper.getMainLooper());
            }
        } catch (SecurityException se) {
            finishAllPending(errorResult("permission_denied", 0));
            return;
        } catch (Throwable t) {
            if (last != null) {
                finishWithLocation(last, "last");
            } else {
                finishAllPending(errorResult("disabled", 0));
            }
            return;
        }
        locationTimeoutRunnable = new Runnable() {
            @Override
            public void run() {
                locationTimeoutRunnable = null;
                onLocationTimeout();
            }
        };
        main.postDelayed(locationTimeoutRunnable, LOCATION_TIMEOUT_MS);
    }

    private void onLocationTimeout() {
        if (!locationInFlight) {
            return;
        }
        appendLog("warn", "location timeout, fallback to lastKnown");
        Location last = freshestLastKnown();
        stopLocationUpdates();
        if (last != null) {
            finishWithLocation(last, "last");
        } else {
            finishAllPending(errorResult("timeout", 0));
        }
    }

    private void stopLocationUpdates() {
        locationInFlight = false;
        if (locationTimeoutRunnable != null) {
            main.removeCallbacks(locationTimeoutRunnable);
            locationTimeoutRunnable = null;
        }
        if (locationListener != null && locationManager != null) {
            try {
                locationManager.removeUpdates(locationListener);
            } catch (Throwable ignored) {
            }
            locationListener = null;
        }
    }

    private Location freshestLastKnown() {
        if (locationManager == null) {
            return null;
        }
        Location best = null;
        String[] providers = new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER};
        for (String p : providers) {
            try {
                Location l = locationManager.getLastKnownLocation(p);
                if (l == null) {
                    continue;
                }
                if (best == null || l.getTime() > best.getTime()) {
                    best = l;
                }
            } catch (Throwable ignored) {
            }
        }
        return best;
    }

    private boolean isProviderEnabled(String provider) {
        if (locationManager == null) {
            return false;
        }
        try {
            return locationManager.isProviderEnabled(provider);
        } catch (Throwable t) {
            return false;
        }
    }

    private void finishWithLocation(Location loc, String providerTag) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("lat", loc.getLatitude());
            o.put("lon", loc.getLongitude());
            o.put("accuracy", loc.hasAccuracy() ? Math.round(loc.getAccuracy()) : -1);
            o.put("provider", providerTag == null || providerTag.length() == 0 ? "last" : providerTag);
            o.put("ts", loc.getTime() > 0 ? loc.getTime() : System.currentTimeMillis());
        } catch (Throwable t) {
            finishAllPending(errorResult("unknown", 0));
            return;
        }
        finishAllPending(o);
    }

    private void finishAllPending(JSONObject result) {
        stopLocationUpdates();
        List<String> ids;
        synchronized (pendingLocationReqs) {
            ids = new ArrayList<String>(pendingLocationReqs);
            pendingLocationReqs.clear();
        }
        String json = result.toString();
        for (String id : ids) {
            callbackLocation(id, json);
        }
    }

    private void callbackLocation(final String reqId, final String resultJson) {
        if (released || webView == null) {
            return;
        }
        webView.post(new Runnable() {
            @Override
            public void run() {
                if (released || webView == null) {
                    return;
                }
                StringBuilder js = new StringBuilder(128);
                js.append("(function(){try{if(typeof window.__nativeLocation==='function'){")
                  .append("window.__nativeLocation(")
                  .append(JSONObject.quote(reqId))
                  .append(',')
                  .append(JSONObject.quote(resultJson))
                  .append(");}}catch(e){}})()");
                evaluate(js.toString());
            }
        });
    }

    // ---------------------------------------------------------------- 生命周期

    public void shutdown() {
        released = true;
        try {
            stopLocationUpdates();
        } catch (Throwable ignored) {
        }
        try {
            pool.shutdownNow();
        } catch (Throwable ignored) {
        }
    }

    // ---------------------------------------------------------------- 工具

    private void evaluate(String js) {
        try {
            WebView wv = webView;
            if (wv != null) {
                wv.evaluateJavascript(js, null);
            }
        } catch (Throwable t) {
            appendLog("warn", "evaluateJavascript failed: " + t);
        }
    }

    private String appVersionName() {
        try {
            return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (Throwable t) {
            return "1.0.0";
        }
    }

    private static int clamp(int v, int min, int max) {
        return v < min ? min : (v > max ? max : v);
    }

    private static JSONObject errorResult(String error, long ms) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("error", error);
            o.put("ms", Math.max(0, ms));
        } catch (Throwable ignored) {
        }
        return o;
    }

    private static Map<String, String> parseHeaders(String json) {
        Map<String, String> out = new LinkedHashMap<String, String>();
        if (json == null) {
            return out;
        }
        String s = json.trim();
        if (s.length() == 0 || "null".equalsIgnoreCase(s)) {
            return out;
        }
        try {
            JSONObject obj = new JSONObject(s);
            Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                if (k == null || k.length() == 0) {
                    continue;
                }
                Object v = obj.opt(k);
                if (v == null || v == JSONObject.NULL) {
                    continue;
                }
                out.put(k, String.valueOf(v));
            }
        } catch (Throwable t) {
            appendLog("warn", "bad headersJson: " + s);
        }
        return out;
    }

    private static byte[] readLimited(InputStream is, int limit) throws IOException {
        if (is == null) {
            return new byte[0];
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream(8192);
        byte[] buf = new byte[16384];
        int total = 0;
        try {
            int n;
            while ((n = is.read(buf)) > 0) {
                int remain = limit - total;
                if (remain <= 0) {
                    break;
                }
                if (n > remain) {
                    n = remain;
                }
                bos.write(buf, 0, n);
                total += n;
                if (total >= limit) {
                    break;
                }
            }
        } finally {
            try {
                is.close();
            } catch (Throwable ignored) {
            }
        }
        return bos.toByteArray();
    }

    private static String charsetOf(String contentType) {
        if (contentType == null) {
            return "UTF-8";
        }
        String lower = contentType.toLowerCase(Locale.US);
        int idx = lower.indexOf("charset=");
        if (idx < 0) {
            return "UTF-8";
        }
        String cs = contentType.substring(idx + "charset=".length()).trim();
        int semi = cs.indexOf(';');
        if (semi >= 0) {
            cs = cs.substring(0, semi).trim();
        }
        if (cs.length() > 1 && cs.startsWith("\"") && cs.endsWith("\"")) {
            cs = cs.substring(1, cs.length() - 1);
        }
        if (cs.length() == 0) {
            return "UTF-8";
        }
        try {
            if (Charset.isSupported(cs)) {
                return cs;
            }
        } catch (Throwable ignored) {
        }
        return "UTF-8";
    }

    private static String decode(byte[] body, String charset) {
        try {
            return new String(body, charset);
        } catch (UnsupportedEncodingException e) {
            try {
                return new String(body, "UTF-8");
            } catch (UnsupportedEncodingException impossible) {
                return new String(body);
            }
        }
    }
}
