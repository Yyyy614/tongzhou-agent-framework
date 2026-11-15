import{test,expect}from'vitest';
test('crash-test database configuration accepts an isolated loopback URL and rejects remote databases',async()=>{
    const{testDatabase}=await import('./helpers/test-database.mjs');
    const url='postgresql://fixture:ci-only-password@127.0.0.1:55437/postgres';
    expect(await testDatabase(url)).toEqual({connectionString:url});
    await expect(testDatabase('postgresql://fixture:ci-only-password@db.example.com/postgres')).rejects.toThrow('loopback');
    await expect(testDatabase('https://localhost/postgres')).rejects.toThrow('PostgreSQL');
});
