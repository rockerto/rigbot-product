// /lib/chat_modules/openai_handler.js
import OpenAI from 'openai';
import { WHATSAPP_FALLBACK_PLACEHOLDER } from '@/lib/chat_modules/config_manager.js'; 
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/lib/defaultSystemPromptTemplate.js';


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL_FALLBACK = process.env.OPENAI_MODEL || 'gpt-4o';

export async function getOpenAIReply(message, effectiveConfig, requestClientId) {
  console.log(`💡 Consulta normal (openai_handler), usando OpenAI para ${requestClientId}`);
  
  let finalSystemPrompt = effectiveConfig.basePrompt || DEFAULT_SYSTEM_PROMPT_TEMPLATE;
  
  finalSystemPrompt = finalSystemPrompt.replace(/\$\{DAYS_TO_QUERY_CALENDAR\}/g, String(effectiveConfig.calendarQueryDays));
  finalSystemPrompt = finalSystemPrompt.replace(/\$\{MAX_DAYS_FOR_USER_REQUEST\}/g, String(effectiveConfig.calendarMaxUserRequestDays));
  
  const wsNum = String(effectiveConfig.whatsappNumber || '').trim();
  if (wsNum && wsNum !== WHATSAPP_FALLBACK_PLACEHOLDER) { 
      finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, wsNum);
  } else {
      finalSystemPrompt = finalSystemPrompt.replace(/\$\{whatsappNumber\}/g, "nuestro principal canal de contacto telefónico o digital");
  }
  finalSystemPrompt = finalSystemPrompt.replace(/\$\{pricingInfo\}/g, String(effectiveConfig.pricingInfo));
  finalSystemPrompt = finalSystemPrompt.replace(/\$\{direccion\}/g, String(effectiveConfig.direccion));
  finalSystemPrompt = finalSystemPrompt.replace(/\$\{horario\}/g, String(effectiveConfig.horario));
  finalSystemPrompt = finalSystemPrompt.replace(/\$\{chiropracticVideoUrl\}/g, String(effectiveConfig.chiropracticVideoUrl));
  finalSystemPrompt = finalSystemPrompt.replace(/\$\{telefono\}/g, String(effectiveConfig.telefono || ""));

  console.log(`System Prompt para OpenAI (clientId: ${requestClientId}, primeros 500 chars):`, finalSystemPrompt.substring(0, 500) + "...");

  const chatResponse = await openai.chat.completions.create({
    model: MODEL_FALLBACK,
    messages: [
      { role: 'system', content: finalSystemPrompt },
      { role: 'user', content: message }
    ]
  });

  let gptReply = chatResponse.choices[0].message.content.trim();
  console.log(`✅ Respuesta generada (OpenAI) para ${requestClientId}:`, gptReply);
  return gptReply;
}