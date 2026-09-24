import type { GameDto, HostOverviewDto, TaskEntryDto } from '@human-bingo/domain';

export type {
  CreateGameResult,
  CreateInvitationResult,
  GameDto,
  GameId,
  GameMutationResult,
  GameSnapshotDto,
  GameStatus,
  GetGameSnapshotResult,
  GridSquareDto,
  HostOverviewDto,
  InvitationPreviewDto,
  InvitationRepresentationDto,
  LeaderboardsDto,
  NotificationDto,
  OnboardingResultDto,
  ResolveInvitationResult,
  SquareStatus,
  TaskEntryDto,
  VerificationRequestDto,
} from '@human-bingo/domain';

export type HostGameDto = {
  readonly game: GameDto;
  readonly tasks: readonly TaskEntryDto[];
  readonly overview: HostOverviewDto;
};
