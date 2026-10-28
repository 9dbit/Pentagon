package id.domainradar.node;

import java.util.concurrent.Callable;
import java.util.function.LongSupplier;

/** At most one actual worker, even when native I/O ignores interruption. */
final class SingleFlight<T> {
    private static final java.util.concurrent.atomic.AtomicBoolean PROCESS_SLOT=new java.util.concurrent.atomic.AtomicBoolean();
    static final class Outcome<T> {
        final String id;
        final T value;
        final Exception error;
        final boolean timedOut;
        Outcome(String id, T value, Exception error, boolean timedOut) {
            this.id=id; this.value=value; this.error=error; this.timedOut=timedOut;
        }
    }
    private final LongSupplier clock;
    private final long limitMs;
    private String id;
    private Thread worker;
    private Runnable cancel;
    private long started;
    private boolean exited, acknowledged, closed;
    private Outcome<T> outcome;

    SingleFlight(LongSupplier clock, long limitMs) { this.clock=clock; this.limitMs=limitMs; }
    synchronized boolean busy() { return id != null || PROCESS_SLOT.get(); }
    synchronized long elapsedMs() { return id == null ? 0 : Math.max(0,clock.getAsLong()-started); }
    synchronized boolean start(String taskId, Callable<T> work, Runnable abort) {
        if (closed || id != null || !PROCESS_SLOT.compareAndSet(false,true)) return false;
        id=taskId; started=clock.getAsLong(); cancel=abort; exited=false; acknowledged=false; outcome=null;
        worker=new Thread(() -> {
            T value=null; Exception error=null;
            try { value=work.call(); } catch (Exception e) { error=e; }
            synchronized (SingleFlight.this) {
                if (!closed && outcome==null) {
                    boolean late=clock.getAsLong()-started >= limitMs;
                    outcome=new Outcome<>(taskId,late?null:value,late?null:error,late);
                }
                exited=true;
                PROCESS_SLOT.set(false);
                clearIfFinished();
            }
        }, "PentagonNodeCheck");
        worker.setDaemon(true);
        worker.start();
        return true;
    }
    void tick() {
        Runnable abort=null; Thread interrupt=null;
        synchronized(this) {
            if (!closed && id!=null && outcome==null && clock.getAsLong()-started>=limitMs) {
                outcome=new Outcome<>(id,null,null,true); abort=cancel; interrupt=worker;
            }
        }
        if (interrupt!=null) interrupt.interrupt();
        if (abort!=null) abort.run();
    }
    synchronized Outcome<T> pending() { return acknowledged ? null : outcome; }
    synchronized void acknowledge(String taskId) {
        if (id!=null && id.equals(taskId) && outcome!=null) { acknowledged=true; clearIfFinished(); }
    }
    private void clearIfFinished() {
        if (exited && acknowledged) { id=null; worker=null; cancel=null; outcome=null; }
    }
    void close() {
        Runnable abort; Thread interrupt;
        synchronized(this) { closed=true; abort=cancel; interrupt=worker; }
        if(interrupt!=null)interrupt.interrupt();
        if(abort!=null)abort.run();
    }
}
