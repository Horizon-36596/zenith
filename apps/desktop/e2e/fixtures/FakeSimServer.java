/*
 * The desktop e2e's sim server, as Java: Zenith starts every sim server as `java @<args>`, and this
 * file is run straight from source (`java FakeSimServer.java ...`, Java 11 and newer). It only hands
 * its arguments and its stdin, stdout and stderr to fake-sim-server.cjs under Node, so the e2e drives
 * the real launch path and the one fake server the unit tests use.
 */
public class FakeSimServer {
    public static void main(String[] args) throws Exception {
        String[] command = new String[args.length + 1];
        command[0] = System.getProperty("fake.node", "node");
        System.arraycopy(args, 0, command, 1, args.length);
        Process process = new ProcessBuilder(command).inheritIO().start();
        System.exit(process.waitFor());
    }
}
