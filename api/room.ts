import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Message, Participant } from '@agent-room/shared';
import {
  appendMessage,
  appendSystemMessage,
  createRoom,
  createRoomReport,
  createRemoteRoomClient,
  endRoom,
  getCurrentTurnState,
  getMessagesWithTotal,
  getRoom,
  joinRoom,
  reactivateRoom,
  removeParticipant,
  setListenUntil,
  sweepRoom,
  RemoteRoomApiError,
} from './_mcpRoomClient.js';

const str = (v: unknown): string =>
  typeof v === 'string' ? v : '';

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function bodyOf(req: VercelRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function applyCors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  applyCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({
      error: 'MethodNotAllowed',
      message: 'POST only',
    });
    return;
  }

  const body = bodyOf(req);

  try {
    const client = createRemoteRoomClient(
      typeof req.headers.host === 'string'
        ? req.headers.host
        : undefined,
    );

    const result = await dispatchRoomHttpAction(client, body);

    res.status(200).json(result);
  } catch (error) {
    writeRoomError(res, error);
  }
}

async function dispatchRoomHttpAction(
  client: ReturnType<typeof createRemoteRoomClient>,
  p: Record<string, unknown>,
): Promise<unknown> {
  switch (p.action) {
    case 'create': {
      if (p.projectId) {
        throw new RemoteRoomApiError(
          'Durable project attachment is not supported by this self-hosted build.',
          400,
          'ProjectAttachUnsupported',
        );
      }

      const room = await createRoom(client, {
        topic: str(p.topic),
        createdBy: str(p.createdBy),
      });

      return {
        room,
        hostKey: room.hostKey,
      };
    }

    case 'get': {
      return {
        room: await getRoom(client, str(p.code)),
      };
    }

    case 'join': {
      const participant = p.participant as Participant;

      if (!participant || typeof participant !== 'object') {
        throw new RemoteRoomApiError(
          'participant is required',
          400,
          'bad_request',
        );
      }

      const joined = await joinRoom(
        client,
        str(p.code),
        participant,
        {
          hostKey: typeof p.hostKey === 'string' ? p.hostKey : undefined,
          priorIdentity:
            p.priorIdentity && typeof p.priorIdentity === 'object'
              ? p.priorIdentity as { name: string; client: 'web' | 'cc' }
              : undefined,
        },
      );

      return {
        room: joined,
        participant: joined.participant,
      };
    }

    case 'messages': {
      return getMessagesWithTotal(
        client,
        str(p.code),
        num(p.cursor, 0),
      );
    }

    case 'sweep': {
      return {
        room: await sweepRoom(client, str(p.code)),
      };
    }

    case 'send': {
      const message = p.message as Message;

      if (!message || typeof message !== 'object') {
        throw new RemoteRoomApiError(
          'message is required',
          400,
          'bad_request',
        );
      }

      const kind = p.kind === 'status' ? 'status' : 'message';

      const result = await appendMessage(
        client,
        str(p.code),
        message,
        kind,
      );

      return { result };
    }

    case 'systemMessage': {
      const message = p.message as Message;

      if (!message || typeof message !== 'object') {
        throw new RemoteRoomApiError(
          'message is required',
          400,
          'bad_request',
        );
      }

      await appendSystemMessage(
        client,
        str(p.code),
        str(p.requesterName),
        typeof p.hostKey === 'string' ? p.hostKey : undefined,
        message,
      );

      return { ok: true };
    }

    case 'presence': {
      await setListenUntil(
        client,
        str(p.code),
        str(p.name),
        num(p.until, Date.now()),
      );

      return { ok: true };
    }

    case 'turnState': {
      return {
        turnState: await getCurrentTurnState(
          client,
          str(p.code),
        ),
      };
    }

    case 'removeParticipant': {
      const targetClient = p.targetClient === 'web' ? 'web' : 'cc';

      return {
        room: await removeParticipant(
          client,
          str(p.code),
          str(p.requesterName),
          str(p.targetName),
          targetClient,
        ),
      };
    }

    case 'end': {
      return {
        room: await endRoom(
          client,
          str(p.code),
          str(p.requesterName),
          typeof p.hostKey === 'string' ? p.hostKey : undefined,
        ),
      };
    }

    case 'reactivate': {
      return {
        room: await reactivateRoom(
          client,
          str(p.code),
          str(p.requesterName),
          typeof p.hostKey === 'string' ? p.hostKey : undefined,
        ),
      };
    }

    case 'createReport': {
      return {
        report: await createRoomReport(
          client,
          str(p.code),
        ),
      };
    }

    case 'setReplyMode':
    case 'directInvoke':
    case 'skipCurrent':
    case 'taskBoard':
    case 'taskCreate':
    case 'taskClaim':
    case 'taskSubmit':
    case 'taskVerify':
    case 'taskReassign':
    case 'taskCancel':
      return client.post(p);

    case 'gameAction':
      throw new RemoteRoomApiError(
        'gameAction is not supported by this self-hosted build.',
        400,
        'unsupported_action',
      );

    default:
      throw new RemoteRoomApiError(
        `Unsupported room action "${String(p.action)}".`,
        400,
        'unsupported_action',
      );
  }
}

const STATUS_BY_ERROR: Record<string, number> = {
  RoomNotFoundError: 404,

  HostNameTakenError: 409,
  InterviewRoomBusyError: 409,

  MutedError: 403,
  NotParticipantError: 403,
  NotHostError: 403,
  NotVerifierError: 403,
  VerifierCannotClaimError: 403,

  NotYourTurnError: 409,
  TaskExistsError: 409,
  TaskStateError: 409,
  OwnerCannotVerifyError: 409,
  TaskDoneImmutableError: 409,

  TaskNotFoundError: 404,

  InvalidModeConfigError: 400,
  ModeNotSupportedError: 400,
  EvidenceIncompleteError: 400,

  WebhookLimitError: 409,
};

function writeRoomError(
  res: VercelResponse,
  error: unknown,
): void {
  if (error instanceof RemoteRoomApiError) {
    res.status(error.status).json({
      error: error.code,
      message: error.message,
    });
    return;
  }

  if (error instanceof Error) {
    const status = STATUS_BY_ERROR[error.name] ?? 500;

    res.status(status).json({
      error: error.name || 'InternalError',
      message: error.message || 'Internal server error',
    });

    return;
  }

  res.status(500).json({
    error: 'InternalError',
    message: 'Internal server error',
  });
}
