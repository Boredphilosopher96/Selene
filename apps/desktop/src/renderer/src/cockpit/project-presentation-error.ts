/** The host has already saved/opened the project; only presentation failed. */
export class ProjectPresentationError extends Error {
  public constructor() {
    super(
      'Your project is saved, but its design tools could not open. Open it from Recent projects to retry.'
    );
    this.name = 'ProjectPresentationError';
  }
}
