import type { WaTurn } from "@/lib/wa-runtime";
export type ChatLocale = "en" | "es";
export function conversationLocale(text: string, previous: ChatLocale = "en"): ChatLocale {
  if (/\b(english|in english)\b/i.test(text)) return "en";
  if (/\b(hola|español|sillas?|barbero|quisiera|necesito|muéstrame|gracias)\b/i.test(text))
    return "es";
  return previous;
}
const spanish: Record<string, string> = {
  "What would help you decide?": "¿Qué te ayudaría a decidir?",
  "Ready to take the next step?": "¿Qué te gustaría hacer ahora?",
  "How would you like to continue?": "¿Cómo te gustaría continuar?",
  "Would you like our team to confirm delivery?":
    "¿Quieres que nuestro equipo confirme la entrega?",
  "Preview in a room": "Ver en un salón",
  "PDF estimate": "Presupuesto PDF",
  "Updated PDF": "PDF actualizado",
  "Adjust image": "Ajustar imagen",
  "Check status": "Consultar estado",
  "Compare products": "Comparar productos",
  "Start generation": "Generar imagen",
  "Not now": "Ahora no",
  "Main menu": "Menú principal",
  "Request status": "Estado de solicitud",
  "Submit request": "Enviar solicitud",
  "Add details": "Añadir detalles",
  "Cancel request": "Cancelar solicitud",
  "Ask our team": "Consultar al equipo",
  "Confirm delivery": "Confirmar entrega",
  "Product support": "Soporte de producto",
  "Use these details": "Usar estos datos",
  "Change details": "Cambiar datos",
  "Find products": "Buscar productos",
  "See it in my salon": "Ver en mi salón",
  "Plan my salon": "Planificar mi salón",
  "Ask a question": "Hacer una pregunta",
};
/** IDs, prices, URLs and product names are never translated. */
export function localizeActions(turns: WaTurn[], locale: ChatLocale): WaTurn[] {
  if (locale !== "es") return turns;
  const translate = (text: string) => spanish[text] ?? text;
  return turns.map((turn) => {
    if (turn.kind === "buttons")
      return {
        ...turn,
        text: translate(turn.text),
        action: {
          ...turn.action,
          buttons: turn.action.buttons.map((button) => ({
            ...button,
            title: translate(button.title),
          })),
        },
      };
    if (turn.kind === "list")
      return {
        ...turn,
        text: translate(turn.text),
        action: {
          ...turn.action,
          button: translate(turn.action.button),
          rows: turn.action.rows.map((row) => ({ ...row, title: translate(row.title) })),
        },
      };
    return turn;
  });
}
