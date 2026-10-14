package com.lucasbrandaocabral.pdfacrobat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin do próprio app (salvar, abrir com, imprimir): registrado antes do Capacitor iniciar.
        registerPlugin(NativeFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
