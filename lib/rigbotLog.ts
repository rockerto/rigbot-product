import { getFirestore } from "firebase-admin/firestore";
import { app } from "./firebase-admin";

const db = getFirestore(app);

interface RigbotMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
  sessionId?: string;
  ip?: string;
}

export async function logRigbotMessage(message: RigbotMessage) {
  try {
    const docRef = db.collection("rigbot_logs").doc();
    const data = {
      ...message,
      timestamp: message.timestamp || Date.now(),
    };
    await docRef.set(data);
    console.log("✅ Mensaje logueado en Firestore");
  } catch (error) {
    console.error("❌ Error al guardar log en Firestore:", error);
  }
}