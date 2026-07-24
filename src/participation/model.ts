export interface ParticipationIdentity {
  readonly subjectId: string;
  readonly actorId?: string;
  readonly networkSignal?: string;
}

export interface SupportResult {
  readonly proposalPublicId: string;
  readonly supportCount: number;
  readonly proposalVersion: number;
  readonly supported: boolean;
}

export interface ParticipationRatePolicy {
  readonly version: number;
  readonly windowSeconds: number;
  readonly retentionSeconds: number;
  readonly subjectLimit: number;
  readonly networkLimit: number;
  readonly globalLimit: number;
}

export interface ParticipationKeyVersion {
  readonly id: string;
  readonly key: string;
}

export const DEFAULT_PARTICIPATION_RATE_POLICY: ParticipationRatePolicy =
  Object.freeze({
    version: 1,
    windowSeconds: 60,
    retentionSeconds: 86_400,
    subjectLimit: 20,
    networkLimit: 120,
    globalLimit: 2_000,
  });
