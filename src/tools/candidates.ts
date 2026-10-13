import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CandidateCreateSchema,
  CandidateUpdateSchema,
  CandidateSearchSchema,
  CandidateTechnicalDataUpdateSchema,
  CandidateAdministrativeUpdateSchema,
  CandidateReferenceCreateSchema,
  CandidateReferenceUpdateSchema,
  CandidateReferenceIdSchema,
} from "../schemas/index.js";
import type {
  CandidateTechnicalDataUpdateInput,
  CandidateAdministrativeUpdateInput,
  CandidateReferenceCreateInput,
  CandidateReferenceUpdateInput,
  CandidateReferenceIdInput,
} from "../schemas/index.js";
import {
  registerSearchTool,
  registerGetTool,
  registerCreateTool,
  registerUpdateTool,
  registerDeleteTool,
  buildJsonApiBody,
  confirmDeletion,
} from "./crud-factory.js";
import { registerTabTools } from "./tab-tools.js";
import type { TabDefinition } from "./tab-tools.js";
import { apiRequest, formatDetailResponse } from "../services/boond-client.js";
import { mergeTechnicalData, fetchTechnicalDataReferences, putTechnicalDataReferences } from "./resources.js";
import type { EmbeddedReference, ReferenceOwner } from "./resources.js";
import type { JsonApiResponse } from "../types.js";

const OPTS = {
  entityName: "candidat",
  entityNamePlural: "candidats",
  apiPath: "/candidates",
  prefix: "boond_candidates",
};

const CANDIDATE_TABS: TabDefinition[] = [
  {
    name: "information",
    tab: "information",
    title: "Informations générales d'un candidat",
    subject: "les informations générales",
    content: "coordonnées, adresse, état civil, photo, tags, source",
    returns: "Bloc identité et coordonnées du candidat.",
  },
  {
    name: "technical_data",
    tab: "technical-data",
    title: "Compétences techniques d'un candidat",
    subject: "le profil technique",
    content: "compétences, expériences, formations, certifications, langues, CV",
    returns:
      "Profil technique du candidat. Les ID de documents (CV) qui s'y trouvent alimentent `boond_documents_get`.",
  },
  {
    name: "administrative",
    tab: "administrative",
    title: "Données administratives d'un candidat",
    subject: "les données administratives",
    content: "pièces justificatives, documents contractuels, informations RH",
    returns: "Bloc administratif du candidat, avec les ID de documents exploitables par `boond_documents_get`.",
  },
  {
    name: "actions",
    tab: "actions",
    title: "Actions liées à un candidat",
    subject: "les actions",
    content: "appels, emails, RDV, notes",
    returns: "Liste des actions rattachées au candidat.",
  },
  {
    name: "positionings",
    tab: "positionings",
    title: "Positionnements d'un candidat",
    subject: "les positionnements",
    content: "placements du candidat sur des opportunités ou des projets",
    returns: "Liste des positionnements du candidat.",
  },
];

const CANDIDATE_SEARCH_DESCRIPTION = `Recherche des candidats dans BoondManager avec filtres serveur.

Cas d'usage courants :
• **Mes candidats** sans connaître son propre ID : \`perimeterDynamic: ["data"]\`. Pour "candidats de l'équipe X" : \`perimeterManagers: [<X_id>]\` (utiliser \`perimeterManagersType: "main"|"hr"\` pour cibler Main vs HR Manager).
• **États / types** : \`candidateStates: [<id>]\` (dictionnaire \`setting.state.candidate\`), \`candidateTypes\` (\`setting.typeOf.resource\`), \`contractTypes\`, \`availabilityTypes\`. IDs entiers issus du dictionnaire.
• **Profil technique** : \`tools: [<id>]\` (OU; pour ET: \`["#AND#", "1", "2"]\`), \`expertiseAreas\`, \`activityAreas\`, \`experiences\`, \`trainings\`, \`mobilityAreas\`, \`languages\` (format \`langueId|niveauId\`).
• **Sourcing** : \`sources: [<id>]\` (origine du candidat), \`evaluations\`.
• **Période** : \`period: "created"|"updated"|"available"|"withActions"|...\` + \`startDate\`/\`endDate\`.
• **Recherche par nom** : \`keywords: "Dupont"\` + \`keywordsType: "lastName"\` (ou firstName, fullName avec \`"NOM#PRENOM"\`, emails, phones, title, titleSkills…). Sans \`keywordsType\`, recherche par défaut dans le CV.
• **Géolocalisation** : \`coordinates: "lat,lon"\` ou \`location\` + \`geoDistance\` (km, 5-200).

Tri : \`sort\` + \`order\`.

Returns : liste paginée des candidats. Utiliser \`boond_candidates_get\` ou les outils d'onglets pour le détail.`;

const CANDIDATE_TECHNICAL_DATA_UPDATE_DESCRIPTION = `Met à jour le dossier technique (DT) d'un candidat : compétences, outils, langues, profils (activityAreas), secteurs (expertiseAreas), formation, diplômes, expérience, résumé.

Mode 'merge' (défaut, recommandé pour automation) — enrichit sans rien écraser :
• skills (CSV) : concatène les compétences absentes
• tools / languages : ajoute les entrées dont la clé (slug outil / langue) est nouvelle, conserve le niveau existant pour les autres
• expertiseAreas, activityAreas, diplomas : ajoute les items absents
• title, summary, training, experience : remplis UNIQUEMENT si actuellement vides

Mode 'replace' — remplace intégralement chaque champ fourni. Les champs non passés ne sont pas touchés.

⚠️ experience, training, expertiseAreas, activityAreas et tools prennent des IDs de dictionnaire (\`setting.experience\`, \`setting.training\`, \`setting.expertiseArea\`, \`setting.activityArea\`, \`setting.tool\`), jamais des libellés.

Les expériences professionnelles (références) ne sont PAS gérées ici : utiliser boond_candidates_reference_{create|update|delete}.

Returns : confirmation, liste des champs envoyés mais non retrouvés dans la réponse de l'API (écriture ignorée par Boond), puis le DT mis à jour.`;

const CANDIDATE_ADMINISTRATIVE_UPDATE_DESCRIPTION = `Met à jour l'onglet Administratif d'un candidat : nationalité, salaire souhaité (fourchette), salaire actuel, contrat souhaité, commentaires.

Seuls les champs fournis sont envoyés. Données personnelles : n'écrire que ce que le candidat a communiqué (CV, entretien).

Returns : confirmation, liste des champs non retrouvés dans la réponse de l'API, puis le bloc administratif mis à jour.`;

const CANDIDATE_OWNER: ReferenceOwner = { apiPath: "/candidates", type: "candidate" };

const CANDIDATE_REFERENCE_CREATE_DESCRIPTION = `Crée une expérience professionnelle (référence) dans le dossier technique d'un candidat.

⚠️ Les références sont des sous-objets embarqués dans le DT, pas une entité REST autonome. L'outil fait read-modify-write : lit la liste actuelle via /candidates/{id}/technical-data, ajoute la nouvelle référence et republie la liste complète (les autres références sont conservées telles quelles).

Champs requis : candidateId, title, company, description.
Dates : startMonth/endMonth en int 1..12 (ou string '1'..'12' sans leading zero) ; startYear/endYear en int 4 chiffres. ⚠️ "05" avec leading zero est rejeté par l'API. Une date inconnue s'omet : une chaîne vide est rejetée (1002).

Pour compléter une référence existante, utiliser boond_candidates_reference_update pour ne pas dupliquer.

Returns : confirmation, nombre total de références et ID de celle créée.`;

const CANDIDATE_REFERENCE_UPDATE_DESCRIPTION = `Met à jour une référence (expérience professionnelle) existante du dossier technique d'un candidat. Read-modify-write sur /candidates/{id}/technical-data — seuls les champs explicitement fournis remplacent ceux de la référence ciblée, les autres champs et toutes les autres références restent intacts.

Cas d'usage type : réécrire la description d'une mission importée d'un CV, ou compléter startMonth/startYear/endMonth/endYear sans toucher au titre ni à la société.

Returns : confirmation et dossier technique republié. Un \`referenceId\` introuvable renvoie \`isError: true\` avec la liste des ID présents.`;

const CANDIDATE_REFERENCE_DELETE_DESCRIPTION = `Supprime une référence (expérience professionnelle) du dossier technique d'un candidat. Read-modify-write : lit la liste actuelle, en retire la référence ciblée, republie le reste. ⚠️ Action irréversible — vérifier l'ID au préalable (\`boond_candidates_technical_data\`).

Returns : confirmation et nombre de références restantes. Un \`referenceId\` introuvable renvoie \`isError: true\` avec la liste des ID présents.`;

function referencesOf(response: JsonApiResponse): EmbeddedReference[] {
  const entity = Array.isArray(response.data) ? response.data[0] : response.data;
  const refs = (entity?.attributes as { references?: unknown } | undefined)?.references;
  return Array.isArray(refs) ? (refs as EmbeddedReference[]) : [];
}

function missingReference(candidateId: string, referenceId: string, current: EmbeddedReference[]) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `❌ Référence #${referenceId} introuvable sur le candidat #${candidateId}. IDs présents: ${current.map((r) => r.id).join(", ") || "(aucun)"}.`,
      },
    ],
  };
}

/**
 * Boond silently drops attributes it does not accept on a PUT (e.g. `mainSkills`
 * on /information). Compare what was sent with what the API echoes back so the
 * caller learns about ignored writes instead of assuming success.
 */
export function unpersistedKeys(sent: Record<string, unknown>, response: JsonApiResponse): string[] {
  const entity = Array.isArray(response.data) ? response.data[0] : response.data;
  const attrs: Record<string, unknown> = entity?.attributes ?? {};
  const norm = (v: unknown): string =>
    JSON.stringify(v, (_k, val: unknown) => (typeof val === "string" ? val.trim() : val)) ?? "";
  return Object.keys(sent).filter((k) => !(k in attrs) || norm(attrs[k]) !== norm(sent[k]));
}

function writeReport(label: string, id: string, sent: Record<string, unknown>, response: JsonApiResponse): string {
  const missing = unpersistedKeys(sent, response);
  const warn =
    missing.length > 0 ? `⚠️ Champs non confirmés par l'API (à vérifier dans Boond) : ${missing.join(", ")}\n\n` : "";
  return `✅ ${label} du candidat #${id} mis à jour.\n\n${warn}${formatDetailResponse(response)}`;
}

function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function registerCandidateTools(server: McpServer): void {
  registerSearchTool(server, OPTS, {
    schema: CandidateSearchSchema,
    description: CANDIDATE_SEARCH_DESCRIPTION,
  });
  registerGetTool(server, OPTS);

  registerCreateTool(server, OPTS, CandidateCreateSchema, (params) => {
    const { ...attrs } = params;
    return buildJsonApiBody("candidate", attrs);
  });

  // Updates go through PUT /candidates/{id}/information — the base resource
  // returns 405 on PATCH (issue #134, same root cause as #124). buildJsonApiBody
  // drops undefined values, so PUT still only touches the supplied fields.
  registerUpdateTool(
    server,
    OPTS,
    CandidateUpdateSchema,
    (params) => {
      const { id, ...attrs } = params;
      return buildJsonApiBody("candidate", attrs, id as string);
    },
    { method: "PUT", pathSuffix: "information" }
  );

  registerDeleteTool(server, OPTS);

  server.registerTool(
    "boond_candidates_technical_data_update",
    {
      title: "Mettre à jour le dossier technique d'un candidat",
      description: CANDIDATE_TECHNICAL_DATA_UPDATE_DESCRIPTION,
      inputSchema: CandidateTechnicalDataUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params: CandidateTechnicalDataUpdateInput) => {
      const { id, mode, ...rest } = params;
      const provided = definedOnly(rest);

      let attributes: Record<string, unknown>;
      if (mode === "replace") {
        attributes = provided;
      } else {
        const currentResponse = await apiRequest(`/candidates/${id}/technical-data`);
        const currentEntity = Array.isArray(currentResponse.data) ? currentResponse.data[0] : currentResponse.data;
        attributes = mergeTechnicalData(currentEntity?.attributes ?? {}, provided);
      }

      if (Object.keys(attributes).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `ℹ️ Dossier technique du candidat #${id} inchangé (aucun champ à mettre à jour en mode ${mode}).`,
            },
          ],
        };
      }

      const body = buildJsonApiBody("candidate", attributes, id);
      const response = await apiRequest(`/candidates/${id}/technical-data`, "PUT", body);
      return {
        content: [
          { type: "text" as const, text: writeReport(`Dossier technique (mode: ${mode})`, id, attributes, response) },
        ],
      };
    }
  );

  server.registerTool(
    "boond_candidates_administrative_update",
    {
      title: "Mettre à jour les données administratives d'un candidat",
      description: CANDIDATE_ADMINISTRATIVE_UPDATE_DESCRIPTION,
      inputSchema: CandidateAdministrativeUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params: CandidateAdministrativeUpdateInput) => {
      const { id, ...rest } = params;
      const attributes = definedOnly(rest);
      if (Object.keys(attributes).length === 0) {
        return {
          content: [
            { type: "text" as const, text: `ℹ️ Données administratives du candidat #${id} inchangées (aucun champ).` },
          ],
        };
      }
      const body = buildJsonApiBody("candidate", attributes, id);
      const response = await apiRequest(`/candidates/${id}/administrative`, "PUT", body);
      return {
        content: [{ type: "text" as const, text: writeReport("Données administratives", id, attributes, response) }],
      };
    }
  );

  server.registerTool(
    "boond_candidates_reference_create",
    {
      title: "Créer une référence (expérience pro) sur un candidat",
      description: CANDIDATE_REFERENCE_CREATE_DESCRIPTION,
      inputSchema: CandidateReferenceCreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params: CandidateReferenceCreateInput) => {
      const { candidateId, ...attrs } = params;
      const current = await fetchTechnicalDataReferences(CANDIDATE_OWNER, candidateId);
      const before = new Set(current.map((r) => String(r.id)));
      const next = [...current, definedOnly(attrs) as EmbeddedReference];
      const response = await putTechnicalDataReferences(CANDIDATE_OWNER, candidateId, next);
      const refs = referencesOf(response);
      // The new entry is the one whose id was not there before; Boond appends it
      // in practice, so the last row is the fallback when ids are not echoed.
      const created = refs.find((r) => r.id !== undefined && !before.has(String(r.id))) ?? refs[refs.length - 1];
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Référence créée sur le candidat #${candidateId} (${refs.length} référence(s) au total).\nID: ${created?.id ?? "(non retourné)"}\n\n${formatDetailResponse(response)}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "boond_candidates_reference_update",
    {
      title: "Modifier une référence (expérience pro) d'un candidat",
      description: CANDIDATE_REFERENCE_UPDATE_DESCRIPTION,
      inputSchema: CandidateReferenceUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params: CandidateReferenceUpdateInput) => {
      const { candidateId, referenceId, ...attrs } = params;
      const current = await fetchTechnicalDataReferences(CANDIDATE_OWNER, candidateId);
      const idx = current.findIndex((r) => String(r.id) === String(referenceId));
      const target = current[idx];
      if (idx === -1 || target === undefined) return missingReference(candidateId, referenceId, current);
      const next = [...current];
      next[idx] = { ...target, ...definedOnly(attrs) };
      const response = await putTechnicalDataReferences(CANDIDATE_OWNER, candidateId, next);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Référence #${referenceId} mise à jour sur le candidat #${candidateId}.\n\n${formatDetailResponse(response)}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "boond_candidates_reference_delete",
    {
      title: "Supprimer une référence (expérience pro) d'un candidat",
      description: CANDIDATE_REFERENCE_DELETE_DESCRIPTION,
      inputSchema: CandidateReferenceIdSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (params: CandidateReferenceIdInput) => {
      const { candidateId, referenceId } = params;
      const confirmation = await confirmDeletion(server, "référence", referenceId);
      if (!confirmation.confirmed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ Suppression de la référence #${referenceId} annulée par l'utilisateur.`,
            },
          ],
        };
      }
      const current = await fetchTechnicalDataReferences(CANDIDATE_OWNER, candidateId);
      const next = current.filter((r) => String(r.id) !== String(referenceId));
      if (next.length === current.length) return missingReference(candidateId, referenceId, current);
      await putTechnicalDataReferences(CANDIDATE_OWNER, candidateId, next);
      return {
        content: [
          {
            type: "text" as const,
            text: `🗑️ Référence #${referenceId} supprimée du candidat #${candidateId} (${next.length} référence(s) restante(s)).`,
          },
        ],
      };
    }
  );

  registerTabTools(server, { ...OPTS, prefix: OPTS.prefix }, CANDIDATE_TABS);
}
