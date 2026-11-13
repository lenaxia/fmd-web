// Violates noImplicitOverride: `describe` overrides `Base.describe`
// without the required `override` modifier.
export class Base {
  public describe(): string {
    return 'base';
  }
}

export class Child extends Base {
  public describe(): string {
    return 'child';
  }
}
