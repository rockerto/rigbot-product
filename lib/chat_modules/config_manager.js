// /lib/chat_modules/config_manager.js
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/lib/defaultSystemPromptTemplate';

export const WHATSAPP_FALLBACK_PLACEHOLDER = "+56900000000";

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
  telefono: ""
};

export function getEffectiveConfig(clientConfigData) {
  let effectiveConfig = { ...defaultConfig }; 
  if (clientConfigData) {
    console.log("INFO (config_manager): Datos crudos de config del cliente desde Firestore:", JSON.stringify(clientConfigData, null, 2).substring(0,300)+"...");
    
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
    
    effectiveConfig.name = clientConfigData.name || "";
    effectiveConfig.plan = clientConfigData.plan || "free";
    effectiveConfig.fallbackMessage = clientConfigData.fallbackMessage || "Lo siento, no te he entendido. ¿Podrías intentarlo de nuevo?";
    effectiveConfig.email = clientConfigData.email || "";
    effectiveConfig.clientId = clientConfigData.clientId; 
    effectiveConfig.createdAt = clientConfigData.createdAt;
    effectiveConfig.welcomeMessage = clientConfigData.welcomeMessage || "";

    effectiveConfig.googleCalendarConnected = clientConfigData.googleCalendarConnected || false;
    effectiveConfig.googleCalendarUserName = clientConfigData.googleCalendarUserName || "";
    effectiveConfig.googleCalendarError = clientConfigData.googleCalendarError || null;
    effectiveConfig.googleCalendarEmail = clientConfigData.googleCalendarEmail || "";
    effectiveConfig.googleCalendarTokens = clientConfigData.googleCalendarTokens || null; 
    effectiveConfig.googleCalendarLastSync = clientConfigData.googleCalendarLastSync || null;
  }
  return effectiveConfig;
}