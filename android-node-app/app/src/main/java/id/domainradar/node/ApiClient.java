package id.domainradar.node;

import android.content.Context;
import org.json.JSONObject;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

class ApiClient {
    private static final OkHttpClient CLIENT=new OkHttpClient.Builder()
            .connectTimeout(10,TimeUnit.SECONDS).readTimeout(12,TimeUnit.SECONDS)
            .writeTimeout(10,TimeUnit.SECONDS).callTimeout(15,TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build();
    static JSONObject post(Context c,String path,JSONObject body) throws Exception {
        Request request=new Request.Builder().url(Prefs.central(c)+path)
                .header("User-Agent","PentagonProviderNode/"+BuildConfig.VERSION_NAME)
                .post(RequestBody.create(body.toString(),MediaType.get("application/json; charset=utf-8"))).build();
        try(Response response=CLIENT.newCall(request).execute()) {
            if(!response.isSuccessful())throw new IOException("HTTP_"+response.code());
            if(response.body()==null)throw new IOException("ACK_REJECTED");
            if(response.body().source().request(65537))throw new IOException("ACK_REJECTED");
            return new JSONObject(response.body().string());
        }
    }
    static void cancelAll() { CLIENT.dispatcher().cancelAll(); }
}
