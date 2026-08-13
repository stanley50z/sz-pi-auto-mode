# Refactor Candidates

After the TDD cycle, look for:

- **Duplication** - extract function/class
- **Long methods** - break into private helpers, but keep tests on public interface
- **Shallow modules** - combine or deepen
- **Feature envy** - move logic to where data lives
- **Primitive obsession** - introduce value objects
- **Existing code** the new code reveals as problematic
