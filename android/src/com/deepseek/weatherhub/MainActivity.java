package com.deepseek.weatherhub;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * 天气汇主 Activity：全屏 WebView + 原生桥 + 本地 assets 拦截。
 *
 * 页面入口固定为 https://app.local/index.html，所有 app.local 资源由
 * {@link AssetServer} 从 APK assets 读取（无需网络、无 file:// 权限）。
 */
public class MainActivity extends Activity {

    public static final String APP_HOST = AssetServer.HOST;
    public static final String START_URL = "https://app.local/index.html";

    private static final int BG_COLOR = 0xFF0B1020;
    private static final long WHITE_SCREEN_GUARD_MS = 10000L;

    /** 白屏守卫：页面加载完 8s 后 #app 仍为空，说明脚本可能崩了。 */
    private static final String RENDER_CHECK_JS =
            "(function(){try{var a=document.getElementById('app');"
            + "if(!a)return 'noapp';var n=0;for(var i=0;i<a.children.length;i++){n++;}"
            + "var t=(a.textContent||'').trim();return (n===0&&t.length===0)?'empty':'ok';"
            + "}catch(e){return 'err';}})()";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private WebView webView;
    private NativeBridge bridge;
    private AssetServer assetServer;
    private FrameLayout root;
    private View errorView;
    private DebugPanel debugPanel;
    private long lastTapAt;
    private int tapCount;
    private float downX;
    private float downY;
    private long downAt;
    private final Runnable whiteScreenGuard = new Runnable() {
        @Override
        public void run() {
            checkRender();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setupWindow();
        buildContentView();

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            try {
                WebView.setWebContentsDebuggingEnabled(true);
            } catch (Throwable ignored) {
            }
        }

        configureWebView();

        bridge = new NativeBridge(this, webView);
        bridge.setFatalErrorListener(new NativeBridge.FatalErrorListener() {
            @Override
            public void onFatalError(String message) {
                showErrorPage("脚本错误：" + message);
            }
        });
        assetServer = new AssetServer(getAssets());
        debugPanel = new DebugPanel(this, root, webView);
        webView.addJavascriptInterface(bridge, "AndroidApp");
        webView.setWebViewClient(new AppWebViewClient());
        webView.setWebChromeClient(new AppChromeClient());

        if (savedInstanceState != null) {
            if (webView.restoreState(savedInstanceState) == null) {
                webView.loadUrl(START_URL);
            }
        } else {
            webView.loadUrl(START_URL);
        }
        NativeBridge.appendLog("info", "MainActivity created, load " + START_URL);
    }

    // ------------------------------------------------------------ 窗口 / 布局

    private void setupWindow() {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(BG_COLOR);
        // API 23 起可用的 SYSTEM_UI_FLAG；状态栏透明 + WebView 顶部 inset 避让，
        // 实现背景延伸到状态栏的沉浸效果（兼容 API 23 到 Android 13+）。
        View decor = window.getDecorView();
        decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    private void buildContentView() {
        root = new FrameLayout(this);
        root.setBackgroundColor(BG_COLOR);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        // 背景铺到状态栏，内容避开状态栏（WebView padding = 状态栏高度）
        webView.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                if (insets != null) {
                    v.setPadding(0, insets.getSystemWindowInsetTop(), 0, 0);
                }
                return insets;
            }
        });

        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
    }

    @SuppressWarnings("deprecation")
    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setLoadsImagesAutomatically(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        String ua = s.getUserAgentString();
        s.setUserAgentString((ua == null ? "" : ua) + " WeatherHub/1.0");
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setDefaultTextEncodingName("utf-8");
        s.setGeolocationEnabled(false); // 定位统一走原生桥
        s.setSaveFormData(false);
        s.setNeedInitialFocus(false);
    }

    // ------------------------------------------------------------ WebView 客户端

    private final class AppWebViewClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            try {
                return assetServer == null ? null : assetServer.handle(request);
            } catch (Throwable t) {
                NativeBridge.appendLog("error", "intercept failed: " + t);
                return null;
            }
        }

        /** 站外链接交给系统浏览器（app.local 内部链接继续在 WebView 内）。 */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (url == null) {
                return false;
            }
            String lower = url.toLowerCase(java.util.Locale.US);
            if (lower.startsWith("https://" + APP_HOST) || lower.startsWith("http://" + APP_HOST)) {
                return false;
            }
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Throwable t) {
                NativeBridge.appendLog("warn", "cannot open external url: " + url);
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            removeErrorView();
            ui.removeCallbacks(whiteScreenGuard);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            NativeBridge.appendLog("info", "page finished: " + url);
            ui.removeCallbacks(whiteScreenGuard);
            ui.postDelayed(whiteScreenGuard, WHITE_SCREEN_GUARD_MS);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            boolean mainFrame = request == null || request.isForMainFrame();
            if (mainFrame) {
                String desc = "未知错误";
                try {
                    if (error != null && error.getDescription() != null) {
                        desc = error.getDescription().toString() + " (" + error.getErrorCode() + ")";
                    }
                } catch (Throwable ignored) {
                }
                showErrorPage("页面加载失败：" + desc);
            }
        }
    }

    private final class AppChromeClient extends WebChromeClient {

        @Override
        public boolean onConsoleMessage(ConsoleMessage cm) {
            if (cm == null) {
                return true;
            }
            String msg = cm.message() == null ? "" : cm.message();
            String level = "log";
            ConsoleMessage.MessageLevel lvl = cm.messageLevel();
            if (lvl == ConsoleMessage.MessageLevel.ERROR) {
                level = "error";
            } else if (lvl == ConsoleMessage.MessageLevel.WARNING) {
                level = "warn";
            } else if (lvl == ConsoleMessage.MessageLevel.TIP || lvl == ConsoleMessage.MessageLevel.DEBUG) {
                level = "debug";
            }
            String where = " @" + (cm.sourceId() == null ? "" : cm.sourceId()) + ":" + cm.lineNumber();
            if (bridge != null) {
                bridge.log(level, msg + where);
            } else {
                NativeBridge.appendLog(level, msg + where);
            }
            if ("error".equals(level)
                    && (msg.startsWith("WH_FATAL") || msg.startsWith("Uncaught SyntaxError"))) {
                showErrorPage("脚本错误：" + msg);
            }
            return true;
        }
    }

    // ------------------------------------------------------------ 白屏 / 错误兜底

    private void checkRender() {
        if (webView == null || isFinishing()) {
            return;
        }
        try {
            webView.evaluateJavascript(RENDER_CHECK_JS, new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    String v = value == null ? "" : value.replace("\"", "").trim();
                    if ("empty".equals(v) || "noapp".equals(v)) {
                        showErrorPage("界面未能渲染（脚本可能出错）");
                    }
                }
            });
        } catch (Throwable t) {
            NativeBridge.appendLog("warn", "render check failed: " + t);
        }
    }

    private void showErrorPage(final String detail) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (isFinishing() || root == null || errorView != null) {
                    return;
                }
                TextView tv = new TextView(MainActivity.this);
                tv.setBackgroundColor(BG_COLOR);
                tv.setTextColor(0xFFE8EEFF);
                tv.setGravity(Gravity.CENTER);
                tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
                tv.setLineSpacing(6f, 1.2f);
                tv.setPadding(dp(28), dp(28), dp(28), dp(28));
                tv.setText("天气汇加载失败\n\n" + (detail == null ? "" : detail) + "\n\n点击屏幕重试");
                tv.setClickable(true);
                tv.setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        removeErrorView();
                        if (webView != null) {
                            webView.reload();
                        }
                    }
                });
                root.addView(tv, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                errorView = tv;
                if (webView != null) {
                    webView.setVisibility(View.INVISIBLE);
                }
                NativeBridge.appendLog("error", "error page shown: " + detail);
            }
        });
    }

    private void removeErrorView() {
        if (errorView != null && root != null) {
            root.removeView(errorView);
        }
        errorView = null;
        if (webView != null) {
            webView.setVisibility(View.VISIBLE);
        }
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    // ------------------------------------------------------------ 返回键 / 生命周期

    @Override
    public void onBackPressed() {
        if (debugPanel != null && debugPanel.isOpen()) {
            debugPanel.close();
            return;
        }
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        // 页面内没有历史：优先交给 JS 消费（弹层/详情页关闭），否则退出
        try {
            webView.evaluateJavascript(
                    "(function(){try{return !!(window.__onBackPressed && window.__onBackPressed());}catch(e){return false;}})()",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            if (!"true".equals(value)) {
                                finish();
                            }
                        }
                    });
        } catch (Throwable t) {
            finish();
        }
    }

    /** 顶部区域连续轻点 5 次 / 长按 -> 调试面板（隐藏手势，不干扰页面交互）。 */
    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (debugPanel != null && !debugPanel.isOpen() && ev != null) {
            int action = ev.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN) {
                downX = ev.getX();
                downY = ev.getY();
                downAt = System.currentTimeMillis();
            } else if (action == MotionEvent.ACTION_UP) {
                long dur = System.currentTimeMillis() - downAt;
                float dx = Math.abs(ev.getX() - downX);
                float dy = Math.abs(ev.getY() - downY);
                boolean topArea = downY < dp(170);
                if (topArea && dx < dp(40) && dy < dp(40)) {
                    if (dur >= 700L) {
                        tapCount = 0;
                        debugPanel.open();
                        return true;
                    }
                    if (dur < 350L) {
                        long now = System.currentTimeMillis();
                        if (now - lastTapAt > 2500L) {
                            tapCount = 0;
                        }
                        lastTapAt = now;
                        tapCount++;
                        if (tapCount >= 5) {
                            tapCount = 0;
                            debugPanel.open();
                            return true;
                        }
                    }
                }
            }
        }
        return super.dispatchTouchEvent(ev);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig); // configChanges 声明后由 WebView 自适应
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (bridge != null) {
            bridge.onRequestPermissionsResult(requestCode, permissions, grantResults);
        }
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (debugPanel != null) {
            debugPanel.close();
            debugPanel = null;
        }
        if (bridge != null) {
            bridge.shutdown();
            bridge = null;
        }
        if (webView != null) {
            try {
                webView.removeJavascriptInterface("AndroidApp");
                if (root != null) {
                    root.removeView(webView);
                }
                webView.destroy();
            } catch (Throwable ignored) {
            }
            webView = null;
        }
        super.onDestroy();
    }
}
