package id.domainradar.node;

import java.io.InterruptedIOException;
import okhttp3.Call;

final class CheckContext {
    private volatile boolean cancelled;
    private volatile Call call;
    synchronized void attach(Call value) { call=value; if(cancelled)value.cancel(); }
    synchronized void cancel() { cancelled=true; if(call!=null)call.cancel(); }
    void check() throws InterruptedIOException {
        if(cancelled || Thread.currentThread().isInterrupted())throw new InterruptedIOException("CHECK_CANCELLED");
    }
}
