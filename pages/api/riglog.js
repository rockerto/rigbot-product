import fs from 'fs';
import path from 'path';

export async function logRigEvent(entry) {
  const logPath = path.join(process.cwd(), 'rigbot_log.json');

  const newEntry = {
    timestamp: new Date().toISOString(),
    ...entry
  };

  let logs = [];

  try {
    if (fs.existsSync(logPath)) {
      const existing = fs.readFileSync(logPath);
      logs = JSON.parse(existing);
    }
  } catch (err) {
    console.error('❌ Error leyendo log existente:', err);
  }

  logs.push(newEntry);

  try {
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
    console.log('✅ Registro agregado al log');
  } catch (err) {
    console.error('❌ Error escribiendo log:', err);
  }
}
