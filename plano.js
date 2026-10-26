'use strict';

// Plano de treino em aparelhos (segunda a sexta, sem agachamento) — usado como exemplo no app.
// dia: 0 = domingo … 6 = sábado. descanso em segundos (ou faixa "60-90").
const PLANO_EXEMPLO = {
  fichas: [
    {
      nome: 'Treino A — Empurrar', foco: 'Peito, ombros e tríceps', dia: 1,
      exercicios: [
        { nome: 'Supino reto na máquina (ou articulado)', series: 4, reps: '10-12', descanso: '60', obs: 'Costas bem apoiadas' },
        { nome: 'Supino inclinado na máquina (ou halteres)', series: 3, reps: '10-12', descanso: '60', obs: 'Foco no peitoral superior' },
        { nome: 'Crucifixo na máquina (peck deck / voador)', series: 3, reps: '12-15', descanso: '45', obs: 'Amplitude controlada' },
        { nome: 'Desenvolvimento de ombros na máquina', series: 4, reps: '10-12', descanso: '60', obs: 'Sem arquear a lombar' },
        { nome: 'Elevação lateral na polia baixa (ou máquina)', series: 3, reps: '12-15', descanso: '45', obs: 'Subir até a linha do ombro' },
        { nome: 'Tríceps pulley (barra reta ou V)', series: 4, reps: '10-12', descanso: '45', obs: 'Cotovelos fixos ao lado' },
        { nome: 'Tríceps corda na polia alta', series: 3, reps: '12-15', descanso: '45', obs: 'Abrir a corda no final' },
        { nome: 'Cardio: esteira inclinada ou elíptico', series: 1, reps: '20-25min', descanso: '', obs: 'Ritmo moderado contínuo' },
      ],
    },
    {
      nome: 'Treino B — Puxar', foco: 'Costas, trapézio e bíceps', dia: 2,
      exercicios: [
        { nome: 'Puxada alta na polia (pegada aberta)', series: 4, reps: '10-12', descanso: '60', obs: 'Puxar em direção à parte alta do peito' },
        { nome: 'Puxada na polia com triângulo (fechada)', series: 3, reps: '10-12', descanso: '60', obs: 'Alongar bem as dorsais na subida' },
        { nome: 'Remada baixa sentado no cabo (ou máquina)', series: 4, reps: '10-12', descanso: '60', obs: 'Tronco firme, peito estufado' },
        { nome: 'Crucifixo inverso na máquina (peck deck)', series: 3, reps: '12-15', descanso: '45', obs: 'Posterior de ombro e trapézio' },
        { nome: 'Rosca direta na polia baixa (barra reta/W)', series: 4, reps: '10-12', descanso: '45', obs: 'Tensão contínua do cabo' },
        { nome: 'Rosca Scott na máquina', series: 3, reps: '10-12', descanso: '45', obs: 'Sem balançar o tronco' },
        { nome: 'Abdominal supra na máquina (ou polia)', series: 3, reps: '15', descanso: '45', obs: 'Soltar o ar contraindo o abdômen' },
        { nome: 'Cardio: bicicleta ou esteira (caminhada rápida)', series: 1, reps: '20-25min', descanso: '', obs: '' },
      ],
    },
    {
      nome: 'Treino C — Pernas', foco: 'Pernas completo, foco em quadríceps (zero agachamento)', dia: 3,
      exercicios: [
        { nome: 'Leg press 45° (ou horizontal)', series: 4, reps: '10-12', descanso: '90', obs: 'Pés no centro da plataforma' },
        { nome: 'Cadeira extensora', series: 4, reps: '12-15', descanso: '60', obs: 'Segurar 1s no topo' },
        { nome: 'Mesa flexora (ou cadeira flexora)', series: 4, reps: '10-12', descanso: '60', obs: 'Quadril apoiado no banco' },
        { nome: 'Cadeira abdutora', series: 3, reps: '15', descanso: '45', obs: 'Movimento controlado' },
        { nome: 'Cadeira adutora', series: 3, reps: '15', descanso: '45', obs: 'Sem bater os pesos' },
        { nome: 'Panturrilha sentado na máquina (ou leg press)', series: 4, reps: '15-20', descanso: '45', obs: 'Amplitude máxima no tornozelo' },
        { nome: 'Cardio: bicicleta ergométrica', series: 1, reps: '20min', descanso: '', obs: 'Ritmo leve a moderado (baixo impacto)' },
      ],
    },
    {
      nome: 'Treino D — Superiores', foco: 'Peito, costas, ombros e braços (metabólico)', dia: 4,
      exercicios: [
        { nome: 'Puxada articulada (ou polia supinada)', series: 3, reps: '12', descanso: '60', obs: '' },
        { nome: 'Supino vertical na máquina', series: 3, reps: '12', descanso: '60', obs: '' },
        { nome: 'Remada cavalinho na máquina (ou articulada)', series: 3, reps: '12', descanso: '60', obs: '' },
        { nome: 'Crossover na polia alta', series: 3, reps: '12-15', descanso: '45', obs: '' },
        { nome: 'Elevação lateral na máquina (ou halteres)', series: 4, reps: '12-15', descanso: '45', obs: '' },
        { nome: 'Bi-set: tríceps testa no cabo + rosca martelo com corda', series: 3, reps: '12+12', descanso: '60', obs: 'Sem pausa entre os dois; descanso só no final' },
        { nome: 'Cardio: esteira inclinada, escada ou elíptico', series: 1, reps: '25min', descanso: '', obs: '' },
      ],
    },
    {
      nome: 'Treino E — Inferiores', foco: 'Posteriores, glúteos e core', dia: 5,
      exercicios: [
        { nome: 'Elevação pélvica na máquina (ou barra no banco)', series: 4, reps: '10-12', descanso: '60-90', obs: 'Contrair os glúteos no topo' },
        { nome: 'Cadeira flexora', series: 4, reps: '12', descanso: '60', obs: 'Ajuste firme sobre a coxa' },
        { nome: 'Leg press 45° (pés mais altos)', series: 3, reps: '12', descanso: '60-90', obs: 'Ênfase em glúteo e posterior' },
        { nome: 'Cadeira extensora', series: 3, reps: '12-15', descanso: '60', obs: 'Estímulo complementar de quadríceps' },
        { nome: 'Extensão de quadril na polia (coice) ou máquina', series: 3, reps: '12/perna', descanso: '45', obs: 'Tronco estabilizado' },
        { nome: 'Panturrilha em pé na máquina (ou horizontal)', series: 4, reps: '15', descanso: '45', obs: 'Sem curvar a coluna' },
        { nome: 'Prancha abdominal isométrica', series: 3, reps: '30-45s', descanso: '45', obs: 'Abdômen e glúteos contraídos' },
        { nome: 'Cardio: aparelho de preferência', series: 1, reps: '20-25min', descanso: '', obs: '' },
      ],
    },
  ],

  nota: {
    titulo: 'Diretrizes — alimentação e desinchaço',
    texto: `Meta segura: perder de 0,5 a 1 kg por semana (déficit de 500 a 750 kcal/dia). Quedas rápidas a mais na balança costumam ser retenção de líquido indo embora.

💧 Água: 35 a 40 ml por kg de peso por dia.
🧂 Sódio: evitar embutidos, temperos prontos, fast-food e ultraprocessados.

Proteínas magras (em todas as refeições): frango grelhado/desfiado, patinho moído, ovos, tilápia ou whey.
Carboidratos base (porções moderadas): arroz, batata-inglesa/doce, aveia e frutas.
Preparo limpo: airfryer, grelha ou panela antiaderente, sem excesso de óleo ou manteiga.

Treino: 60 a 80 min/dia — aquecimento articular (5 min), musculação em aparelhos (~45–50 min) e cardio final (20–25 min).
Carga: as 2 últimas repetições de cada série devem ser desafiadoras, com postura alinhada. Respeite o descanso no relógio.

⚠ Antes de mudar treino ou dieta, valide com médico, nutricionista e o professor da academia.`,
  },
};
