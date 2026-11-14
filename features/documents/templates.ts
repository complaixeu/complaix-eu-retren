import {
  OperatorId,
  RenderedTemplate,
  TemplateKind,
  type OperatorId as OperatorIdValue,
  type TemplateKind as TemplateKindValue,
} from "@/shared/contracts";

type TemplateVars = Record<string, string> & { ref: string };

const OPERATOR_NAMES: Record<OperatorIdValue, string> = {
  iryo: "Iryo",
  renfe: "Renfe",
  ouigo: "OUIGO",
};

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function value(vars: TemplateVars, name: string): string | undefined {
  const raw = vars[name];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

function required(vars: TemplateVars, name: string, kind: TemplateKindValue): string {
  const result = value(vars, name);
  if (!result) throw new Error(`renderTemplate ${kind}: missing required variable "${name}"`);
  return result;
}

function optionalLine(text: string | undefined): string[] {
  return text ? [text] : [];
}

function signature(vars: TemplateVars): string {
  const passenger = value(vars, "passengerName");
  return passenger ? `Retren, en representación de ${passenger}` : "Retren";
}

function salutation(operatorName: string): string {
  return `A la atención de ${operatorName}:`;
}

function documentLabel(vars: TemplateVars): string | undefined {
  const number = value(vars, "documentNumber");
  if (!number) return undefined;
  const type = value(vars, "documentType");
  const typeLabel = type
    ? ({ dni: "DNI", nie: "NIE", passport: "pasaporte" }[type.toLowerCase()] ?? type)
    : "documento";
  return `${typeLabel} ${number}`;
}

function paymentLabel(raw: string): string {
  if (raw === "money") return "dinero";
  if (raw === "voucher") return "vale";
  return raw;
}

function initialClaim(vars: TemplateVars, operatorName: string): string[] {
  const passengerName = value(vars, "passengerName");
  const trip = [value(vars, "travelDate"), value(vars, "origin"), value(vars, "destination")]
    .filter((part): part is string => Boolean(part))
    .join("; ");
  const ticketRef = value(vars, "ticketRef");
  const doc = documentLabel(vars);
  const payment = value(vars, "paymentPreference");
  const details = [
    ticketRef ? `billete o localizador: ${ticketRef}` : undefined,
    doc ? `documento: ${doc}` : undefined,
    payment ? `preferencia de pago: ${paymentLabel(payment)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return [
    `${salutation(value(vars, "operatorName") ?? operatorName)} Retren presenta una reclamación por retraso${passengerName ? ` en representación de ${passengerName}` : ""}.`,
    trip ? `Datos del viaje: ${trip}.` : "El expediente se refiere a un viaje ferroviario.",
    `Solicitamos la indemnización que corresponda conforme al Reglamento (UE) 2021/782.${details.length ? ` ${details.join(". ")}.` : ""}`,
    signature(vars),
  ];
}

const PREVIOUS_DATES: Partial<Record<TemplateKindValue, readonly string[]>> = {
  reminder_d12: ["sentDate"],
  reminder_d30: ["sentDate", "reminderD12Date"],
  last_notice_d40: ["sentDate", "reminderD12Date", "reminderD30Date"],
  escalation_d45: ["sentDate", "reminderD12Date", "reminderD30Date", "lastNoticeD40Date"],
};

function followUp(kind: TemplateKindValue, vars: TemplateVars, operatorName: string): string[] {
  const dates = (PREVIOUS_DATES[kind] ?? [])
    .map((name) => value(vars, name))
    .filter((date): date is string => Boolean(date));
  const dateSummary = dates.length
    ? `La reclamación y las comunicaciones anteriores se enviaron el ${dates.join(", el ")}.`
    : "Seguimos pendientes de respuesta a la reclamación presentada.";

  const requestByKind: Record<string, string> = {
    reminder_d12: "Agradecemos que nos confirme la recepción y el estado de tramitación.",
    reminder_d30:
      "Ha transcurrido un mes desde la reclamación; agradecemos una respuesta motivada.",
    last_notice_d40:
      "Si no recibimos respuesta, el expediente se elevará a la autoridad competente.",
    escalation_d45:
      "Al no haber respuesta, comunicamos que el expediente se elevará a la DGTT o a la Junta Arbitral de Transporte.",
  };

  return [
    salutation(operatorName),
    dateSummary,
    `${requestByKind[kind]} El Reglamento (UE) 2021/782 establece el plazo de respuesta aplicable.`,
    signature(vars),
  ];
}

function insistence(vars: TemplateVars, operatorName: string): string[] {
  const trip = [value(vars, "travelDate"), value(vars, "origin"), value(vars, "destination")]
    .filter((part): part is string => Boolean(part))
    .join("; ");
  const doc = documentLabel(vars);
  const details = [trip ? `viaje: ${trip}` : undefined, doc ? `documento: ${doc}` : undefined]
    .filter((part): part is string => Boolean(part))
    .join("; ");
  const tripLine = details
    ? `Reiteramos la reclamación (${details}).`
    : "Reiteramos la reclamación por retraso.";
  return [
    `${salutation(operatorName)} Solicitamos reconsiderar la denegación del expediente.`,
    `${tripLine} El Reglamento (UE) 2021/782 reconoce el derecho a indemnización según la duración del retraso.`,
    signature(vars),
  ];
}

function operatorReply(
  kind: TemplateKindValue,
  vars: TemplateVars,
  operatorName: string,
): string[] {
  const ref = required(vars, "ref", kind);
  const passenger = value(vars, "passengerName");
  const docLine = documentLabel(vars);

  switch (kind) {
    case "reply_acknowledgement":
      return [
        `${salutation(operatorName)} Gracias por confirmar la recepción del expediente [${ref}].`,
        ...optionalLine(docLine ? `Documento del expediente: ${docLine}.` : undefined),
        "Quedamos pendientes de la resolución y del plazo previsto para su tramitación.",
        signature(vars),
      ];
    case "reply_asks_for_data": {
      const details = [
        passenger ? `persona representada: ${passenger}` : undefined,
        docLine ? `documento: ${docLine}` : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join("; ");
      return [
        `${salutation(operatorName)} Adjuntamos la documentación solicitada para el expediente [${ref}].`,
        ...optionalLine(details ? `${details}.` : undefined),
        "Agradecemos que confirme su recepción y la continuación de la tramitación.",
        signature(vars),
      ];
    }
    case "reply_approved":
      return [
        `${salutation(operatorName)} Gracias por aprobar la reclamación [${ref}].`,
        ...optionalLine(docLine ? `Documento del expediente: ${docLine}.` : undefined),
        "Agradecemos que confirme el importe y el plazo previsto para el abono o la entrega del vale.",
        signature(vars),
      ];
    case "reply_denied":
      return [
        `${salutation(operatorName)} Hemos recibido la denegación de la reclamación [${ref}].`,
        ...optionalLine(docLine ? `Documento del expediente: ${docLine}.` : undefined),
        "Solicitamos que indique los motivos concretos y la base aplicada a la decisión.",
        signature(vars),
      ];
    case "reply_refers_to_form":
      return [
        `${salutation(operatorName)} La reclamación [${ref}] se presentó por correo con la documentación requerida.`,
        ...optionalLine(docLine ? `Documento del expediente: ${docLine}.` : undefined),
        "Agradecemos que confirme si es posible continuar su tramitación por este canal.",
        signature(vars),
      ];
    default:
      return [];
  }
}

function userNotice(kind: TemplateKindValue, vars: TemplateVars): string[] {
  const ref = required(vars, "ref", kind);
  const operatorName = value(vars, "operatorName");
  if (kind === "user_request_document") {
    return [
      `La compañía ha solicitado documentación adicional para continuar el expediente [${ref}].`,
      "Responde a este correo adjuntando el documento que te han pedido.",
      ...optionalLine(operatorName ? `La solicitud corresponde a ${operatorName}.` : undefined),
      signature(vars),
    ];
  }

  const result = value(vars, "result");
  const reason = value(vars, "reason");
  if (result === "approved") {
    return [
      `La compañía ha aprobado la reclamación [${ref}].`,
      "Confirma respondiendo a este correo si recibiste el dinero o el vale.",
      ...optionalLine(operatorName ? `Compañía: ${operatorName}.` : undefined),
      signature(vars),
    ];
  }
  if (result === "denied") {
    return [
      `La reclamación [${ref}] ha recibido una respuesta desfavorable y el expediente se cierra.`,
      "Si necesitas revisar el resultado, contacta con el equipo de Retren.",
      ...optionalLine(operatorName ? `Compañía: ${operatorName}.` : undefined),
      signature(vars),
    ];
  }
  if (result === "not_eligible") {
    return [
      `No podemos presentar la reclamación [${ref}] porque no reúne los requisitos de elegibilidad.`,
      ...optionalLine(reason ? `Motivo: ${reason}` : undefined),
      "El equipo de Retren puede aclarar cualquier duda sobre esta evaluación.",
      signature(vars),
    ];
  }

  const sentDate = value(vars, "sentDate");
  const closeLine = sentDate
    ? `La reclamación se envió el ${sentDate} y ha finalizado el plazo de seguimiento.`
    : "Ha finalizado el plazo de seguimiento de la reclamación.";
  return [
    `El expediente [${ref}] se cierra al concluir el plazo de seguimiento.`,
    closeLine,
    "No consta una respuesta que permita continuar la tramitación.",
    signature(vars),
  ];
}

function renderText(kind: TemplateKindValue, vars: TemplateVars, operatorName: string): string[] {
  switch (kind) {
    case "initial_claim":
      return initialClaim(vars, operatorName);
    case "reminder_d12":
    case "reminder_d30":
    case "last_notice_d40":
    case "escalation_d45":
      return followUp(kind, vars, operatorName);
    case "insistence_after_denial":
      return insistence(vars, operatorName);
    case "reply_acknowledgement":
    case "reply_asks_for_data":
    case "reply_approved":
    case "reply_denied":
    case "reply_refers_to_form":
      return operatorReply(kind, vars, operatorName);
    case "user_request_document":
    case "user_final_result":
      return userNotice(kind, vars);
  }
}

function subjectFor(kind: TemplateKindValue): string {
  switch (kind) {
    case "initial_claim":
      return "Reclamación por retraso";
    case "reminder_d12":
      return "Seguimiento de la reclamación";
    case "reminder_d30":
      return "Solicitud de respuesta a la reclamación";
    case "last_notice_d40":
      return "Último aviso sobre la reclamación";
    case "escalation_d45":
      return "Comunicación de escalada del expediente";
    case "insistence_after_denial":
      return "Solicitud de reconsideración de la reclamación";
    case "reply_acknowledgement":
      return "Seguimiento de recepción";
    case "reply_asks_for_data":
      return "Documentación solicitada";
    case "reply_approved":
      return "Confirmación de resolución favorable";
    case "reply_denied":
      return "Solicitud de motivación de la denegación";
    case "reply_refers_to_form":
      return "Seguimiento de reclamación presentada por correo";
    case "user_request_document":
      return "Documentación adicional para tu reclamación";
    case "user_final_result":
      return "Actualización final de tu reclamación";
  }
}

/** Renders a fixed, operator-specific template. No operator-provided prose enters the output. */
export function renderTemplate(
  kind: TemplateKindValue,
  operator: OperatorIdValue,
  vars: TemplateVars,
): { subject: string; text: string } {
  const parsedKind = TemplateKind.parse(kind);
  const parsedOperator = OperatorId.parse(operator);
  const ref = required(vars, "ref", parsedKind);
  if (!/^RTN-[A-Z0-9]+$/.test(ref)) throw new Error("renderTemplate: ref must match RTN-[A-Z0-9]+");
  const operatorName = value(vars, "operatorName") ?? OPERATOR_NAMES[parsedOperator];
  const text = renderText(parsedKind, vars, operatorName).join("\n");
  return RenderedTemplate.parse({ subject: `[${ref}] ${subjectFor(parsedKind)}`, text });
}
