// rigbot-product/lib/firebase-admin.ts
import { initializeApp, cert, getApps, getApp, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { getAuth, Auth } from "firebase-admin/auth"; // <--- ¡IMPORTANTE! Añadir import para Auth

let app: App;
let db: Firestore;
let authInstance: Auth; // <--- ¡IMPORTANTE! Declarar variable para la instancia de Auth

// Variable para asegurar que los logs de inicialización solo se muestren una vez por instancia de servidor
let adminSdkInitializedLog = false;

if (!getApps().length) {
  try {
    const serviceAccountString = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!serviceAccountString || serviceAccountString.trim() === "") {
      console.error("CRITICAL ERROR: La variable de entorno GOOGLE_APPLICATION_CREDENTIALS no está definida o está vacía en Vercel para el proyecto rigbot-product.");
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS no definida o vacía.");
    }
    
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountString); 
    } catch (parseError) {
      console.error("CRITICAL ERROR: No se pudo parsear el JSON de GOOGLE_APPLICATION_CREDENTIALS. Verifica que el valor sea un JSON válido y completo en Vercel. Error de parseo:", parseError);
      console.error("Valor problemático (primeros/últimos 100 chars):", serviceAccountString.substring(0,100), "...", serviceAccountString.slice(-100));
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS no es un JSON válido.");
    }
    
    app = initializeApp({
      credential: cert(serviceAccount)
    });
    if (!adminSdkInitializedLog) {
      console.log("Firebase Admin SDK inicializado con credenciales parseadas explícitamente desde firebase-admin.ts.");
      adminSdkInitializedLog = true;
    }
    db = getFirestore(app);
    authInstance = getAuth(app); // <--- ¡IMPORTANTE! Crear la instancia de Auth

  } catch (e) {
    console.error("Error GLOBAL CRÍTICO durante la inicialización de Firebase Admin SDK en firebase-admin.ts:", (e as Error).message);
    // Aquí podrías decidir si relanzar el error o si las variables quedan como undefined y se manejan en uso.
    // Por ahora, si falla aquí, authInstance y db podrían ser undefined.
  }
} else {
  app = getApp();
  db = getFirestore(app);
  authInstance = getAuth(app); // <--- ¡IMPORTANTE! Obtener la instancia de Auth si la app ya existe
  if (!adminSdkInitializedLog) {
    console.log("Firebase Admin SDK ya estaba inicializado (firebase-admin.ts), obteniendo instancias existentes.");
    adminSdkInitializedLog = true;
  }
}

// Asegurarse de que db y authInstance se exporten incluso si la inicialización primaria falló (serán undefined)
// Las funciones que los usen DEBEN verificar si son válidos antes de usarlos.
// Sin embargo, el throw new Error en el bloque try debería detener la ejecución si las credenciales son el problema.

export { db, app, authInstance as auth }; // <--- ¡IMPORTANTE! Exportar la instancia de Auth como 'auth'