package id.domainradar.node;

import android.net.DnsResolver;
import android.net.Network;
import android.os.Build;
import android.os.CancellationSignal;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

final class NetworkDns {
    static List<InetAddress> resolve(Network network,String host) throws UnknownHostException {
        long start=android.os.SystemClock.elapsedRealtime();
        NodeDiagnostics.phase("dns");
        try {
            // Older Android native DNS is isolated by SingleFlight: if it does not
            // honour interruption, heartbeat continues but no second worker starts.
            if(Build.VERSION.SDK_INT<29)return Arrays.asList(network!=null?network.getAllByName(host):InetAddress.getAllByName(host));
            CountDownLatch ready=new CountDownLatch(1);
            AtomicReference<List<InetAddress>> answer=new AtomicReference<>();
            CancellationSignal cancel=new CancellationSignal();
            try {
                DnsResolver.getInstance().query(network,host,0,Runnable::run,cancel,new DnsResolver.Callback<List<InetAddress>>() {
                    @Override public void onAnswer(List<InetAddress> values,int rcode) { if(rcode==0)answer.set(values); ready.countDown(); }
                    @Override public void onError(DnsResolver.DnsException e) { ready.countDown(); }
                });
                if(!ready.await(8,TimeUnit.SECONDS))throw new UnknownHostException("DNS_DEADLINE");
                if(answer.get()==null || answer.get().isEmpty())throw new UnknownHostException("DNS_FAILED");
                return answer.get();
            } catch(InterruptedException e) {
                Thread.currentThread().interrupt(); throw new UnknownHostException("DNS_CANCELLED");
            } finally { cancel.cancel(); }
        } finally { NodeDiagnostics.timing("dns",android.os.SystemClock.elapsedRealtime()-start); NodeDiagnostics.phase("http"); }
    }
}
