// ============================================================
// EMERGENCY AGENT - urgent dental cases.
// ============================================================

const { behaviorContract, todayLine, nowDate } = require('./sharedPrompt');

function buildPrompt(patient, clinicInfo, memoryContext, languageState = 'unknown') {
  const patientCtx = patient
    ? `PACIENTE: ${patient.patientName} (ID interno ${patient.patientId}; nunca digas o ID).`
    : 'PACIENTE NAO IDENTIFICADO: se for preciso marcar, recolhe apenas nome completo antes de book_appointment.';

  const now = nowDate();
  const day = now.getDay();
  const hour = now.getHours() + now.getMinutes() / 60;
  const isOpen = day >= 1 && day <= 5 && hour >= 9 && hour < 19.5;
  const statusLine = isOpen
    ? 'ESTADO: clinica aberta agora; procura o slot urgente mais rapido.'
    : 'ESTADO: clinica fechada agora; da orientacao segura fora de horas.';

  return `${behaviorContract(languageState)}
${todayLine()}
${statusLine}
${patientCtx}

TAREFA — DOR / URGENCIA (REGRA OBRIGATORIA):
Quando o paciente refere dor, urgencia, inchaco, sangramento, dente partido ou
acidente, NAO marcas consulta, NAO dás conselhos, NAO diagnosticas, NAO fazes
perguntas clinicas. Fazes SEMPRE e APENAS o seguinte, numa unica fala curta:
  1. Reconhece com empatia que ele esta com dores ("Lamento muito que esteja com dores. Compreendo perfeitamente.").
  2. Deseja as melhoras ("Espero que fique melhor em breve." / "As melhoras.").
  3. Diz que vais passar a chamada a um colega da equipa e que ele deve ficar na linha.
  4. action = "transfer_to_human".

NUNCA uses check_slots nem book_appointment nesta situacao. NUNCA dês orientacao
clinica (nem "tome um analgesico", nem "ponha gelo", nem encaminhamento para 112/
hospital). Apenas: empatia + melhoras + ficar na linha + transferir.

DEVOLVE APENAS JSON VALIDO:
{
  "speak": "Lamento muito que esteja com dores. Compreendo perfeitamente. Vou passar já a chamada a um colega da nossa equipa para o ajudar — fique na linha, por favor. As melhoras!",
  "action": "transfer_to_human",
  "params": {}
}`;
}

module.exports = { buildPrompt };
