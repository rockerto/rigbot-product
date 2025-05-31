// /lib/chat_modules/config_manager.js
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/lib/defaultSystemPromptTemplate';

export const WHATSAPP_FALLBACK_PLACEHOLDER = "+56900000000";

// Valores por defecto para las nuevas configuraciones de Lead Capture
const defaultLeadCaptureConfig = {
  leadCaptureEnabled: false, // Por defecto, desactivado
  clinicNameForLeadPrompt: "la clínica", // Un nombre genérico
  leadNotificationEmail: "", // Vacío por defecto, se debería usar el email del cliente si no se especifica
  leadCaptureOfferPromptTemplate: "Soy RigBot, asistente de {clinicName}. Para una atención más directa y si lo prefieres, ¿te gustaría dejarme tu nombre y contacto para que te llamemos o escribamos?",
  leadCaptureNamePrompt: "¡Entendido! Para comenzar, ¿cuál es tu nombre completo?",
  leadCaptureContactPromptTemplate: "Muchas gracias, {userName}. Ahora, ¿me podrías facilitar tu número de teléfono o tu dirección de email para el contacto?",
  leadCaptureMessagePrompt: "Perfecto. Si deseas, puedes dejar un breve mensaje o el motivo principal de tu consulta (esto es opcional).",
  leadCaptureConfirmationPromptTemplate: "¡Excelente, {userName}! He registrado tus datos. Desde {clinicName} se comunicarán contigo muy pronto. Mientras tanto, ¿hay algo más en lo que te pueda asistir?"
};

export const defaultConfig = {
  basePrompt: process.env.RIGBOT_PROMPT || DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  calendarQueryDays: 7,
  calendarMaxUserRequestDays: 21,
  maxSuggestions: 5,
  whatsappNumber: process.env.RIGBOT_DEFAULT_WSP || WHATSAPP_FALLBACK_PLACEHOLDER,
  pricingInfo: "Nuestros precios son competitivos. Por favor, consulta al contactarnos.",
  direccion: "Nuestra consulta está en Copiapó. Te daremos los detalles exactos al agendar.",
  horario: "Atendemos de Lunes a Viernes, de 10:00 a 19:30.",
  chiropracticVideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  telefono: "",
  welcomeMessage: "¡Hola! ¿En qué puedo ayudarte hoy?", // Default welcome message
  fallbackMessage: "Lo siento, no te he entendido. ¿Podrías intentarlo de nuevo?",
  ...defaultLeadCaptureConfig // Incluir los defaults de lead capture aquí
};

export function getEffectiveConfig(clientConfigData) {
  let effectiveConfig = { ...defaultConfig }; // Empezar con los defaults (que ya incluyen los de lead capture)
  
  if (clientConfigData) {
    console.log("INFO (config_manager): Datos crudos de config del cliente desde Firestore:", JSON.stringify(clientConfigData, null, 2).substring(0, 500) + "...");
    
    // Sobrescribir con clientConfigData campo por campo para asegurar fallbacks y tipos
    effectiveConfig.basePrompt = clientConfigData.basePrompt || defaultConfig.basePrompt;
    effectiveConfig.calendarQueryDays = Number(clientConfigData.calendarQueryDays) || defaultConfig.calendarQueryDays;
    effectiveConfig.calendarMaxUserRequestDays = Number(clientConfigData.calendarMaxUserRequestDays) || defaultConfig.calendarMaxUserRequestDays;
    effectiveConfig.maxSuggestions = clientConfigData.maxSuggestions !== undefined ? Number(clientConfigData.maxSuggestions) : defaultConfig.maxSuggestions;
    effectiveConfig.whatsappNumber = String(clientConfigData.whatsappNumber || defaultConfig.whatsappNumber).trim();
    effectiveConfig.pricingInfo = String(clientConfigData.pricingInfo || defaultConfig.pricingInfo);
    effectiveConfig.direccion = String(clientConfigData.direccion || defaultConfig.direccion);
    effectiveConfig.horario = String(clientConfigData.horario || defaultConfig.horario);
    effectiveConfig.chiropracticVideoUrl = String(clientConfigData.chiropracticVideoUrl || defaultConfig.chiropracticVideoUrl);
    effectiveConfig.telefono = String(clientConfigData.telefono || defaultConfig.telefono);
    effectiveConfig.welcomeMessage = clientConfigData.welcomeMessage || defaultConfig.welcomeMessage;
    effectiveConfig.fallbackMessage = clientConfigData.fallbackMessage || defaultConfig.fallbackMessage;
    
    // Campos generales del cliente que no están en defaultConfig pero pueden venir de Firestore
    effectiveConfig.name = clientConfigData.name || "Cliente RigBot"; // Añadido un default más genérico
    effectiveConfig.plan = clientConfigData.plan || "free";
    effectiveConfig.email = clientConfigData.email || "";
    effectiveConfig.clientId = clientConfigData.clientId; 
    effectiveConfig.createdAt = clientConfigData.createdAt;

    // Campos de Google Calendar
    effectiveConfig.googleCalendarConnected = clientConfigData.googleCalendarConnected || false;
    effectiveConfig.googleCalendarUserName = clientConfigData.googleCalendarUserName || "";
    effectiveConfig.googleCalendarError = clientConfigData.googleCalendarError || null;
    effectiveConfig.googleCalendarEmail = clientConfigData.googleCalendarEmail || "";
    effectiveConfig.googleCalendarTokens = clientConfigData.googleCalendarTokens || null; 
    effectiveConfig.googleCalendarLastSync = clientConfigData.googleCalendarLastSync || null;

    // --- LECTURA EXPLÍCITA DE CAMPOS DE LEAD CAPTURE ---
    effectiveConfig.leadCaptureEnabled = typeof clientConfigData.leadCaptureEnabled === 'boolean' ? clientConfigData.leadCaptureEnabled : defaultConfig.leadCaptureEnabled;
    effectiveConfig.clinicNameForLeadPrompt = clientConfigData.clinicNameForLeadPrompt || effectiveConfig.name || defaultConfig.clinicNameForLeadPrompt; // Fallback al nombre del cliente si no hay clinicName
    effectiveConfig.leadNotificationEmail = clientConfigData.leadNotificationEmail || effectiveConfig.email || defaultConfig.leadNotificationEmail; // Fallback al email del cliente
    
    effectiveConfig.leadCaptureOfferPromptTemplate = clientConfigData.leadCaptureOfferPromptTemplate || defaultConfig.leadCaptureOfferPromptTemplate;
    effectiveConfig.leadCaptureNamePrompt = clientConfigData.leadCaptureNamePrompt || defaultConfig.leadCaptureNamePrompt;
    effectiveConfig.leadCaptureContactPromptTemplate = clientConfigData.leadCaptureContactPromptTemplate || defaultConfig.leadCaptureContactPromptTemplate;
    effectiveConfig.leadCaptureMessagePrompt = clientConfigData.leadCaptureMessagePrompt || defaultConfig.leadCaptureMessagePrompt;
    effectiveConfig.leadCaptureConfirmationPromptTemplate = clientConfigData.leadCaptureConfirmationPromptTemplate || defaultConfig.leadCaptureConfirmationPromptTemplate;
  }
  return effectiveConfig;
}