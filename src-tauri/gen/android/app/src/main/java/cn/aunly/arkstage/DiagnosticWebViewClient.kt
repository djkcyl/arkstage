package cn.aunly.arkstage

import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Message
import android.webkit.*
import androidx.annotation.RequiresApi

/** Preserve Wry's protocol/IPC client. Only renderer termination is handled here. */
@RequiresApi(26)
class DiagnosticWebViewClient(private val delegate: WebViewClient, private val gone: (WebView, RenderProcessGoneDetail) -> Unit) : WebViewClient() {
  override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) = delegate.shouldInterceptRequest(view, request)
  @Suppress("DEPRECATION") override fun shouldInterceptRequest(view: WebView, url: String) = delegate.shouldInterceptRequest(view, url)
  override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = delegate.shouldOverrideUrlLoading(view, request)
  @Suppress("DEPRECATION") override fun shouldOverrideUrlLoading(view: WebView, url: String) = delegate.shouldOverrideUrlLoading(view, url)
  override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) = delegate.onPageStarted(view, url, favicon)
  override fun onPageFinished(view: WebView, url: String) = delegate.onPageFinished(view, url)
  override fun onLoadResource(view: WebView, url: String) = delegate.onLoadResource(view, url)
  override fun onPageCommitVisible(view: WebView, url: String) = delegate.onPageCommitVisible(view, url)
  override fun doUpdateVisitedHistory(view: WebView, url: String, reload: Boolean) = delegate.doUpdateVisitedHistory(view, url, reload)
  override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) = delegate.onReceivedError(view, request, error)
  @Suppress("DEPRECATION") override fun onReceivedError(view: WebView, code: Int, description: String, url: String) = delegate.onReceivedError(view, code, description, url)
  override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) = delegate.onReceivedHttpError(view, request, response)
  override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) = delegate.onReceivedSslError(view, handler, error)
  override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) = delegate.onReceivedHttpAuthRequest(view, handler, host, realm)
  override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) = delegate.onReceivedClientCertRequest(view, request)
  override fun onFormResubmission(view: WebView, dontResend: Message, resend: Message) = delegate.onFormResubmission(view, dontResend, resend)
  override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) = delegate.onScaleChanged(view, oldScale, newScale)
  override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
    CrashDiagnostics.write("renderer-gone didCrash=${detail.didCrash()} priority=${detail.rendererPriorityAtExit()}")
    try { gone(view, detail) }
    catch (error: Exception) { CrashDiagnostics.write("renderer recovery failed: $error") }
    // Returning false here causes Android to kill the host app too.
    return true
  }
}
