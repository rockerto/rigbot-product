export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Falta el mensaje del usuario' });
  }

  const functions = [
    {
      name: "getAvailableAppointments",
      description: "Consulta la disponibilidad de horas",
      parameters: {
        type: "object",
        properties: {
          start_date: {
            type: "string",
            description: "Fecha inicial en formato YYYY-MM-DD"
          },
          end_date: {
            type: "string",
            description: "Fecha final en formato YYYY-MM-DD"
          },
          preferred_time: {
            type: "string",
            description: "Hora preferida del paciente (formato HH:mm, opcional)"
          }
        },
        required: ["start_date", "end_date"]
      }
    }
  ];

  const messages = [
    {
      role: "system",
      content: "Eres Rigbot, un asistente empático que ayuda a encontrar horas disponibles en una consulta quiropráctica en Copiapó. Solo respondes cuando tengas la información necesaria."
    },
    {
      role: "user",
      content: message
    }
  ];

  try {
    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4-1106-preview",
        messages,
        functions,
        function_call: "auto"
      })
    });

    const data = await completion.json();

    if (data.choices?.[0]?.finish_reason === "function_call") {
      const fn = data.choices[0].message.function_call;
      const args = JSON.parse(fn.arguments);

      const response = await fetch(`${req.headers.origin}/api/getavailableappointments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(args)
      });

      const availability = await response.json();

      messages.push({
        role: "function",
        name: "getAvailableAppointments",
        content: JSON.stringify(availability)
      });

      const final = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4-1106-preview",
          messages
        })
      });

      const finalData = await final.json();
      return res.status(200).json({ response: finalData.choices[0].message.content });
    } else {
      return res.status(200).json({ response: data.choices[0].message.content });
    }
  } catch (error) {
    console.error("Error en /api/message:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
}
