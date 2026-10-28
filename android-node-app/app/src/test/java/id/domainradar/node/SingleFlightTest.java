package id.domainradar.node;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicBoolean;

public class SingleFlightTest {
    private static void awaitExit(SingleFlight<?> flight) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);
        while(flight.busy() && System.nanoTime()<end)Thread.sleep(1);
        assertFalse(flight.busy());
    }
    private static SingleFlight.Outcome<String> awaitResult(SingleFlight<String> flight) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);
        while(flight.pending()==null && System.nanoTime()<end)Thread.sleep(1);
        assertNotNull(flight.pending()); return flight.pending();
    }
    @Test public void blockedCheckerDoesNotBlockHeartbeatOrAllowSecondJob() throws Exception {
        AtomicLong clock=new AtomicLong(); CountDownLatch gate=new CountDownLatch(1);
        SingleFlight<String> s=new SingleFlight<>(clock::get,100);
        try {
            assertTrue(s.start("a",()->{gate.await();return "ok";},()->{}));
            for(int i=0;i<100;i++){s.tick();assertTrue(s.busy());assertNull(s.pending());}
            assertFalse(s.start("b",()->"bad",()->{}));
            gate.countDown(); assertEquals("ok",awaitResult(s).value);
            assertTrue(s.busy()); // remains busy until its result has been acknowledged
            s.acknowledge("wrong-id");assertTrue(s.busy());
            s.acknowledge("a");awaitExit(s);
        } finally { gate.countDown();s.close(); }
    }
    @Test public void timeoutStaysTerminalAndNativeWorkerCannotOverlapEvenAfterServiceRestart() throws Exception {
        AtomicLong clock=new AtomicLong(); CountDownLatch entered=new CountDownLatch(1),gate=new CountDownLatch(1);
        AtomicBoolean cancelled=new AtomicBoolean();
        SingleFlight<String> s=new SingleFlight<>(clock::get,100);
        SingleFlight<String> nextService=new SingleFlight<>(clock::get,100);
        try {
            assertTrue(s.start("a",()->{entered.countDown();while(gate.getCount()>0){try{gate.await();}catch(InterruptedException ignored){}}return "late";},()->cancelled.set(true)));
            assertTrue(entered.await(2,TimeUnit.SECONDS));clock.set(100);s.tick();
            assertTrue(s.pending().timedOut);assertNull(s.pending().value);assertTrue(cancelled.get());
            s.acknowledge("a");assertTrue(s.busy());assertNull(s.pending());
            assertFalse(nextService.start("b",()->"overlap",()->{}));
            gate.countDown();awaitExit(s);assertNull(s.pending());
            assertTrue(nextService.start("c",()->"new",()->{}));
            assertEquals("new",awaitResult(nextService).value);nextService.acknowledge("c");awaitExit(nextService);
        } finally {gate.countDown();s.close();nextService.close();}
    }
    @Test public void lateCompletionIsExpiredEvenBeforeTick() throws Exception {
        AtomicLong clock=new AtomicLong();SingleFlight<String>s=new SingleFlight<>(clock::get,100);
        try {
            assertTrue(s.start("a",()->{clock.set(101);return "late";},()->{}));
            assertTrue(awaitResult(s).timedOut);assertNull(s.pending().value);
            s.acknowledge("a");awaitExit(s);
        } finally{s.close();}
    }
    @Test public void failedResultIsRetainedForRetryUntilAck() throws Exception {
        SingleFlight<String>s=new SingleFlight<>(()->0L,100);
        try {
            s.start("a",()->{throw new java.io.IOException("test");},()->{});
            SingleFlight.Outcome<String> result=awaitResult(s);assertNotNull(result.error);assertFalse(result.timedOut);
            assertSame(result,s.pending());s.acknowledge("a");awaitExit(s);
        } finally{s.close();}
    }
    @Test public void stopCancelsAndNeverPublishesLateResult() throws Exception {
        CountDownLatch entered=new CountDownLatch(1),gate=new CountDownLatch(1),exited=new CountDownLatch(1);
        AtomicBoolean cancel=new AtomicBoolean();SingleFlight<String>s=new SingleFlight<>(()->0L,100);
        try {
            s.start("a",()->{entered.countDown();try{gate.await();return "late";}finally{exited.countDown();}},()->cancel.set(true));
            assertTrue(entered.await(2,TimeUnit.SECONDS));s.close();gate.countDown();assertTrue(cancel.get());
            assertTrue(exited.await(2,TimeUnit.SECONDS));assertFalse(s.start("b",()->"bad",()->{}));assertNull(s.pending());
        } finally {gate.countDown();s.close();}
    }
}
