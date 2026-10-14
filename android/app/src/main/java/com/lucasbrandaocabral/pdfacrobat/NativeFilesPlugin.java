package com.lucasbrandaocabral.pdfacrobat;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Arquivos no Android para o app web: salvar pelo seletor do sistema ("Salvar
 * como") e de novo no mesmo documento, salvar vários numa pasta, receber os
 * PDFs abertos com "Abrir com" ou "Compartilhar", imprimir e abrir links no
 * navegador. Os bytes passam em base64.
 */
@CapacitorPlugin(name = "NativeFiles")
public class NativeFilesPlugin extends Plugin {

    private static final String EVENT_FILE_OPENED = "fileOpened";
    // Acima disso o arquivo não cabe com folga na memória do app web.
    private static final long MAX_BYTES = 100L * 1024 * 1024;

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    // ---- Documentos recebidos ----

    /** Também recebe o intent que abriu o app (o Capacitor o repassa ao carregar). */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        List<Uri> uris = urisOf(intent);
        if (uris.isEmpty()) return;
        io.execute(() -> {
            JSArray files = new JSArray();
            String error = null;
            for (Uri uri : uris) {
                try {
                    JSObject file = new JSObject();
                    file.put("name", displayName(uri));
                    file.put("mimeType", getContext().getContentResolver().getType(uri));
                    file.put("data", readBase64(uri));
                    files.put(file);
                } catch (Exception e) {
                    error = e.getMessage();
                }
            }
            JSObject event = new JSObject();
            event.put("files", files);
            if (error != null) event.put("error", error);
            // Guardado até o app web começar a escutar (na abertura do app).
            notifyListeners(EVENT_FILE_OPENED, event, true);
        });
    }

    private static List<Uri> urisOf(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        if (intent == null) return uris;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (uri != null) uris.add(uri);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (list != null) uris.addAll(list);
        }
        return uris;
    }

    // ---- Salvar ----

    /**
     * Salva `data` (base64). Com `uri`, grava de novo no documento salvo antes;
     * sem, abre o "Salvar como" do sistema com o nome `name`.
     */
    @PluginMethod
    public void save(PluginCall call) {
        if (call.getString("data") == null) {
            call.reject("Nada para salvar.");
            return;
        }
        String uri = call.getString("uri");
        if (uri != null) {
            io.execute(() -> writeAndResolve(call, Uri.parse(uri)));
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mimeType", "application/pdf"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "documento.pdf"));
        startActivityForResult(call, intent, "saveResult");
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(new JSObject().put("canceled", true));
            return;
        }
        Uri uri = data.getData();
        io.execute(() -> writeAndResolve(call, uri));
    }

    private void writeAndResolve(PluginCall call, Uri uri) {
        try {
            write(uri, Base64.decode(call.getString("data"), Base64.DEFAULT));
            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            ret.put("name", displayName(uri));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Não foi possível salvar: " + e.getMessage(), e);
        }
    }

    /** Escolhe uma pasta e grava nela os arquivos `files` ([{ name, mimeType, data }]). */
    @PluginMethod
    public void saveMany(PluginCall call) {
        startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "saveManyResult");
    }

    @ActivityCallback
    private void saveManyResult(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(new JSObject().put("canceled", true));
            return;
        }
        Uri tree = data.getData();
        io.execute(() -> {
            try {
                ContentResolver resolver = getContext().getContentResolver();
                Uri folder = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
                JSONArray files = call.getArray("files");
                int count = 0;
                for (int i = 0; i < files.length(); i++) {
                    JSONObject file = files.getJSONObject(i);
                    String mimeType = file.optString("mimeType", "application/octet-stream");
                    Uri created = DocumentsContract.createDocument(resolver, folder, mimeType, file.getString("name"));
                    if (created == null) throw new IOException("a pasta não aceitou o arquivo " + file.getString("name"));
                    write(created, Base64.decode(file.getString("data"), Base64.DEFAULT));
                    count++;
                }
                JSObject ret = new JSObject();
                ret.put("count", count);
                ret.put("folder", displayName(folder));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Não foi possível salvar os arquivos: " + e.getMessage(), e);
            }
        });
    }

    // ---- Imprimir e abrir links ----

    /** Imprime o PDF `data` (base64) pelo serviço de impressão do Android. */
    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("name", "documento.pdf");
        File file = new File(getContext().getCacheDir(), "impressao.pdf");
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
        } catch (IOException e) {
            call.reject("Não foi possível preparar a impressão: " + e.getMessage(), e);
            return;
        }
        getActivity()
            .runOnUiThread(() -> {
                PrintManager printManager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                printManager.print(name, new PdfPrintAdapter(file, name), new PrintAttributes.Builder().build());
                call.resolve();
            });
    }

    /** Abre um endereço https no navegador (ex.: o download da versão nova). */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://")) {
            call.reject("Endereço inválido.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("Nenhum navegador encontrado para abrir o endereço.");
        }
    }

    // ---- Leitura e gravação ----

    private void write(Uri uri, byte[] bytes) throws IOException {
        OutputStream out;
        try {
            // "wt" apaga o conteúdo antigo ao gravar de novo no mesmo documento.
            out = getContext().getContentResolver().openOutputStream(uri, "wt");
        } catch (IllegalArgumentException | FileNotFoundException e) {
            out = getContext().getContentResolver().openOutputStream(uri, "w");
        }
        if (out == null) throw new IOException("o local escolhido não aceita gravação");
        try (OutputStream stream = out) {
            stream.write(bytes);
        }
    }

    private String readBase64(Uri uri) throws IOException {
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new FileNotFoundException("arquivo não encontrado");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) != -1) {
                out.write(buffer, 0, n);
                if (out.size() > MAX_BYTES) throw new IOException("o arquivo passa de 100 MB");
            }
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        }
    }

    private String displayName(Uri uri) {
        String name = null;
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (
                Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)
            ) {
                if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
            } catch (Exception ignored) {
                // Sem nome do provedor: usa o fim do endereço.
            }
        }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment();
        return name == null || name.isEmpty() ? "documento" : name;
    }

    /** Entrega ao serviço de impressão o PDF já pronto, sem redesenhar as páginas. */
    private static class PdfPrintAdapter extends PrintDocumentAdapter {

        private final File file;
        private final String name;

        PdfPrintAdapter(File file, String name) {
            this.file = file;
            this.name = name;
        }

        @Override
        public void onLayout(
            PrintAttributes oldAttributes,
            PrintAttributes newAttributes,
            CancellationSignal cancellationSignal,
            LayoutResultCallback callback,
            Bundle extras
        ) {
            if (cancellationSignal.isCanceled()) {
                callback.onLayoutCancelled();
                return;
            }
            PrintDocumentInfo info = new PrintDocumentInfo.Builder(name)
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
                .build();
            callback.onLayoutFinished(info, !newAttributes.equals(oldAttributes));
        }

        @Override
        public void onWrite(
            PageRange[] pages,
            ParcelFileDescriptor destination,
            CancellationSignal cancellationSignal,
            WriteResultCallback callback
        ) {
            try (InputStream in = new FileInputStream(file); OutputStream out = new FileOutputStream(destination.getFileDescriptor())) {
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) != -1) {
                    if (cancellationSignal.isCanceled()) {
                        callback.onWriteCancelled();
                        return;
                    }
                    out.write(buffer, 0, n);
                }
                callback.onWriteFinished(new PageRange[] { PageRange.ALL_PAGES });
            } catch (IOException e) {
                callback.onWriteFailed(e.getMessage());
            }
        }
    }
}
