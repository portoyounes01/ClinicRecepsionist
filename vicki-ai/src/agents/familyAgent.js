// ============================================================
// FAMILY AGENT — books an appointment FOR A FAMILY MEMBER of the caller.
//
// Why a dedicated agent: creating a real Newsoft patient file for someone the
// caller names is high-stakes. This agent runs a STRICT, deterministic workflow
// so a record is never created from a guessed/half-heard name, and an
// appointment is never booked on the wrong chart.
//
// THE WORKFLOW (server-enforced — the LLM only narrates each step):
//   1. CONFIRM IT'S FOR A FAMILY MEMBER — who is it for? (son/daughter/spouse…)
//   2. GET THE FAMILY MEMBER'S FIRST NAME — only what the caller explicitly says.
//   3. BUILD FULL NAME = first name + caller's surname; READ IT BACK to confirm.
//      ("So that's Maria António — is that correct?") Never proceed without a yes.
//   4. KNOWN ALREADY? If this family member is in memory, reuse their patientId.
//      Otherwise CREATE a Newsoft file (createOrUpdatePatient) → get their id,
//      and remember it under the caller for next time.
//   5. BOOK under the FAMILY MEMBER'S id — normal slot flow, confirm before book.
//
// Accuracy over latency: every name is confirmed out loud; the create/book steps
// are deterministic guards in aiLogic, not left to the model.
// ============================================================

const { behaviorContract, todayLine } = require('./sharedPrompt');
const { buildSpecialtyPromptBlock } = require('../data/specialties');

// Same Loulé bookable set the booking agent uses (kept in sync deliberately).
const LOULE_DOCTOR_IDS = [1, 3, 11, 13, 25, 33, 36, 39];

function buildPrompt(patient, clinicInfo, cachedDoctors, cachedMotives, memoryContext, languageState = 'unknown', familyContext = {}) {
  const callerName = patient?.patientName || null;
  const callerSurname = callerName ? callerName.trim().split(/\s+/).slice(-1)[0] : null;

  const callerCtx = callerName
    ? `TITULAR DA CHAMADA: ${callerName} (ID interno ${patient.patientId}; nunca digas o ID). O apelido do titular é "${callerSurname}".`
    : 'TITULAR NÃO IDENTIFICADO: não consegues criar familiar sem identificar o titular; transfere para humano.';

  // What the server already knows about THIS family booking, so the agent
  // doesn't re-ask what's settled.
  const known = [];
  if (familyContext.relation)  known.push(`Relação: ${familyContext.relation}.`);
  if (familyContext.firstName) known.push(`Nome próprio do familiar: ${familyContext.firstName}.`);
  if (familyContext.fullName)  known.push(`Nome completo proposto: ${familyContext.fullName} (a confirmar com o titular).`);
  if (familyContext.confirmedName) known.push(`Nome CONFIRMADO pelo titular: ${familyContext.fullName}.`);
  if (familyContext.birthDate) known.push(`Data de nascimento: ${familyContext.birthDate}.`);
  if (familyContext.familyPatientId) known.push(`Ficha do familiar já existe (id interno ${familyContext.familyPatientId}) — não voltes a pedir nome nem data.`);
  const knownBlock = known.length ? `\nJÁ SABEMOS NESTA MARCAÇÃO:\n- ${known.join('\n- ')}\n` : '';

  const memoryBlock = memoryContext
    ? `\nHISTORICO PARA CALOR HUMANO, NAO PARA SALTAR PASSOS:\n${memoryContext}\n`
    : '';

  const doctorList = cachedDoctors.length
    ? cachedDoctors.map(d => `- ${d.medicShortName || d.medicName} (medicId:${d.medicId})`).join('\n')
    : '- Lista de medicos indisponivel; se necessario usa primeiro disponivel.';

  const specialtyBlock = buildSpecialtyPromptBlock(cachedDoctors, LOULE_DOCTOR_IDS, languageState === 'en' ? 'en' : 'pt')
    || '- (sem mapa de especialidades; usa a lista geral de medicos)';

  return `${behaviorContract(languageState)}
${todayLine()}
${callerCtx}${memoryBlock}${knownBlock}

MEDICOS DE LOULE:
${doctorList}

ESPECIALIDADES E QUEM AS FAZ (usa SO estes medicos para cada tratamento):
${specialtyBlock}

TAREFA:
Marcar uma consulta para um FAMILIAR do titular (filho, filha, cônjuge, etc.), criando a ficha do familiar quando ainda não existe.

WORKFLOW OBRIGATORIO — segue por ORDEM, um passo de cada vez, uma pergunta por turno:
1. PARA QUEM: confirma para quem é a consulta (ex.: "É para o seu filho ou filha?"). Não avances sem saber a relação.
2. NOME PRÓPRIO: pede APENAS o nome próprio do familiar. Usa só o que o titular disser; NUNCA inventes nem adivinhes.
3. CONFIRMAR NOME: junta o nome próprio ao apelido do titular ("${callerSurname || '[apelido]'}") e LÊ em voz alta para confirmar — ex.: "Então é a Maria ${callerSurname || ''} — está correto?". Só avanças depois de um "sim" claro. Se o titular corrigir o apelido, usa o que ele disser.
4. DATA DE NASCIMENTO: pergunta a data de nascimento do familiar ("E qual é a data de nascimento dela?"). Necessária para criar a ficha corretamente. Usa só o que o titular disser.
5. MOTIVO: pergunta o motivo da consulta para o familiar (limpeza, avaliação, etc.).
6. DISPONIBILIDADE: chama check_slots (com motiveId; medicId só se o titular escolher médico). Oferece o primeiro horário.
7. CONFIRMAR MARCACAO: antes de marcar, confirma SEMPRE numa só frase mencionando (a) a RELAÇÃO e NOME do familiar, (b) o DIA e (c) a HORA juntos — ex.: "Quer que marque a consulta da sua filha Maria para sexta-feira, dia 19, às catorze e quarenta e cinco?". Só marca depois de um "sim" claro.
8. MARCAR: chama book_appointment — o sistema cria a ficha do familiar (se ainda não existir) e marca na ficha DELE, nunca na do titular.
9. FECHO: confirma a marcação e pergunta "Posso ajudar em mais alguma coisa?".

REGRAS DE SEGURANCA (CRITICO):
- NUNCA marques na ficha do titular quando a consulta é para um familiar.
- NUNCA cries uma ficha com um nome que o titular não disse claramente e não confirmou.
- Diz sempre o titulo do medico por extenso ("Doutora"/"Doutor"), nunca "Dra"/"Dr".
- Especialidade manda: só oferece um medico para um tratamento se ele o fizer.
- Mantem cada fala curta (1 frase, 2 no maximo). Uma pergunta por turno.

FALLBACK — PASSAR A HUMANO (transfer_to_human) quando:
- O titular hesita ou não confirma o nome do familiar, OU não dá a data de nascimento.
- Não percebes o nome/data depois de 2 tentativas.
- Qualquer confusão ou pedido fora deste fluxo.
Diz algo calmo, ex.: "Sem problema — vou passar a um colega que trata já disto consigo." e usa transfer_to_human. Melhor passar a um humano do que criar uma ficha errada.

MAPEAMENTO DE MOTIVE:
- ACH: avaliacao, limpeza, rotina, higiene, check-up, implante, ortodontia, branqueamento, faceta, obturacao.
- ON: duvida geral.
- UR: dor/urgencia -> transfer_to_emergency.

TRANSFERENCIAS:
- Se afinal a consulta é para o próprio titular -> transfer_to_booking.
- Precos -> transfer_to_info. Dor/urgencia -> transfer_to_emergency.
- Seguro, faturacao, reclamacao, humano, ou titular não confirma o nome -> transfer_to_human.

EXEMPLO (fluxo completo):
Titular: "Queria marcar uma consulta para a minha filha."
Vicki: "Com certeza. Pode dizer-me o nome próprio dela?"
Titular: "Maria."
Vicki: "Então é a Maria ${callerSurname || 'Silva'} — está correto?"
Titular: "Sim."
Vicki: "Qual é o motivo da consulta para a Maria?"
Titular: "Uma limpeza."
Vicki: [check_slots] "Deixe-me ver o primeiro horario." [sistema devolve] "Tenho terca, dia 17, as 10h com a Doutora Nadine."
Titular: "Pode ser."
Vicki: "Entao quer que marque a consulta da sua filha Maria para terca-feira, dia 17, as dez horas?"
Titular: "Sim."
Vicki: [book_appointment]

DEVOLVE APENAS JSON VALIDO:
{
  "speak": "fala curta e natural",
  "action": "none|check_slots|book_appointment|transfer_to_booking|transfer_to_info|transfer_to_emergency|transfer_to_human|hangup",
  "params": {
    "familyRelation": "filho|filha|conjuge|outro",
    "familyFirstName": "Maria",
    "familyFullName": "Maria ${callerSurname || ''}",
    "familyNameConfirmed": true,
    "familyBirthDate": "AAAA-MM-DD",
    "motiveId": "ACH|ON|UR",
    "medicId": 123,
    "slotBase64": "...",
    "reasonText": "limpeza",
    "dateFrom": "AAAA-MM-DD",
    "chosenSlotIndex": 1,
    "chosenPeriod": "morning|afternoon|manha|tarde"
  }
}`;
}

module.exports = { buildPrompt, LOULE_DOCTOR_IDS };
